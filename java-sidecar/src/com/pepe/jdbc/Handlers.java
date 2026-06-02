package com.pepe.jdbc;

import com.fasterxml.jackson.databind.JsonNode;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.Driver;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;

/** Dispatches RPC methods to JDBC operations. */
public final class Handlers {
  static final String VERSION = "0.2.0";
  private static final int DEFAULT_MAX_ROWS = 5000;

  private final DriverRegistry drivers = new DriverRegistry();
  private final ConnectionRegistry conns = new ConnectionRegistry();

  public Object dispatch(String method, JsonNode params) throws Exception {
    if (method == null) throw new RpcError("INVALID_REQUEST", "missing method");
    switch (method) {
      case "ping":             return ping();
      case "loadDriver":       return loadDriver(params);
      case "connect":          return connect(params);
      case "disconnect":       return disconnect(params);
      case "exec":             return exec(params);
      case "meta.tables":      return metaTables(params);
      case "meta.columns":     return metaColumns(params);
      case "meta.primaryKeys": return metaPrimaryKeys(params);
      case "meta.schemas":     return metaSchemas(params);
      case "meta.functions":   return metaFunctions(params);
      case "meta.procedures":  return metaProcedures(params);
      case "meta.indexes":     return metaIndexes(params);
      case "meta.tableTypes":  return metaTableTypes(params);
      case "meta.procedureColumns": return metaProcedureColumns(params);
      case "meta.functionColumns":  return metaFunctionColumns(params);
      default: throw new RpcError("UNKNOWN_METHOD", "unknown method: " + method);
    }
  }

  // ── Methods ────────────────────────────────────────────────────────────────

  private Map<String, Object> ping() {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("ok", true);
    m.put("version", VERSION);
    m.put("javaVersion", System.getProperty("java.version"));
    m.put("javaVendor", System.getProperty("java.vendor"));
    m.put("os", System.getProperty("os.name"));
    m.put("connections", conns.size());
    return m;
  }

  private Map<String, Object> loadDriver(JsonNode p) {
    String id = req(p, "driverId");
    String cls = req(p, "className");
    List<String> jars = new ArrayList<>();
    JsonNode arr = p.get("jars");
    if (arr != null && arr.isArray()) for (JsonNode n : arr) jars.add(n.asText());
    if (jars.isEmpty()) throw new RpcError("INVALID_REQUEST", "jars must be non-empty");
    drivers.loadDriver(id, cls, jars);
    return single("driverId", id);
  }

  private Map<String, Object> connect(JsonNode p) {
    String connId = req(p, "connectionId");
    String driverId = req(p, "driverId");
    String url = req(p, "url");
    String user = optString(p, "user", null);
    String pw   = optString(p, "password", null);

    Properties props = new Properties();
    if (user != null) props.setProperty("user", user);
    if (pw != null) props.setProperty("password", pw);
    JsonNode extra = p.get("props");
    if (extra != null && extra.isObject()) {
      Iterator<Map.Entry<String, JsonNode>> it = extra.fields();
      while (it.hasNext()) {
        Map.Entry<String, JsonNode> e = it.next();
        props.setProperty(e.getKey(), e.getValue().asText());
      }
    }

    Driver d = drivers.getDriver(driverId);
    if (d == null) throw new RpcError("DRIVER_NOT_FOUND", "driver not loaded: " + driverId);

    Connection conn;
    // Many JDBC drivers (Altibase, Oracle, ...) do internal Class.forName via
    // the thread context class loader during connect(). Make sure that lookup
    // hits the driver's URLClassLoader, not the sidecar's system loader.
    ClassLoader prev = Thread.currentThread().getContextClassLoader();
    ClassLoader driverCl = drivers.getClassLoader(driverId);
    try {
      if (driverCl != null) Thread.currentThread().setContextClassLoader(driverCl);
      conn = d.connect(url, props);
    } catch (SQLException sqe) { throw sqlError(sqe); }
    catch (Throwable t) { throw new RpcError("INTERNAL", t.toString()); }
    finally {
      Thread.currentThread().setContextClassLoader(prev);
    }
    if (conn == null) throw new RpcError("CONNECT_FAILED",
        "driver returned null connection — URL not accepted by '" + driverId + "': " + url);

    conns.put(connId, conn);

    Map<String, Object> info = new LinkedHashMap<>();
    try {
      DatabaseMetaData md = conn.getMetaData();
      info.put("productName", md.getDatabaseProductName());
      info.put("productVersion", md.getDatabaseProductVersion());
      info.put("driverName", md.getDriverName());
      info.put("driverVersion", md.getDriverVersion());
      info.put("url", md.getURL());
      info.put("catalog", safeCatalog(conn));
      info.put("schema", safeSchema(conn));
    } catch (SQLException ignore) {}
    info.put("ok", true);
    info.put("connectionId", connId);
    return info;
  }

  private Map<String, Object> disconnect(JsonNode p) {
    String connId = req(p, "connectionId");
    Connection c = conns.remove(connId);
    if (c != null) try { c.close(); } catch (Exception ignore) {}
    return single("ok", true);
  }

  private Map<String, Object> exec(JsonNode p) {
    String connId = req(p, "connectionId");
    String sql = req(p, "sql");
    int maxRows = optInt(p, "maxRows", DEFAULT_MAX_ROWS);

    Connection c = conns.get(connId);
    if (c == null) throw new RpcError("CONNECTION_NOT_FOUND", connId);

    ClassLoader prev = Thread.currentThread().getContextClassLoader();
    ClassLoader connCl = c.getClass().getClassLoader();
    try {
      if (connCl != null) Thread.currentThread().setContextClassLoader(connCl);
    try (Statement st = c.createStatement()) {
      // Fetch one extra row so we can detect truncation deterministically.
      st.setMaxRows(maxRows + 1);
      boolean hasResult = st.execute(sql);

      Map<String, Object> out = new LinkedHashMap<>();
      if (hasResult) {
        try (ResultSet rs = st.getResultSet()) {
          serializeResultSet(rs, maxRows, out);
        }
        out.put("rowsAffected", 0);
      } else {
        out.put("columns", new ArrayList<>());
        out.put("types", new ArrayList<>());
        out.put("rows", new ArrayList<>());
        out.put("truncated", false);
        out.put("rowsAffected", Math.max(0, st.getUpdateCount()));
      }
      return out;
    } catch (SQLException sqe) {
      throw sqlError(sqe);
    }
    } finally { Thread.currentThread().setContextClassLoader(prev); }
  }

  private Map<String, Object> metaTables(JsonNode p) {
    String connId = req(p, "connectionId");
    String catalog = optString(p, "catalog", null);
    String schema = optString(p, "schema", null);
    String[] types = optStringArray(p, "types");
    Connection c = conns.get(connId);
    if (c == null) throw new RpcError("CONNECTION_NOT_FOUND", connId);

    ClassLoader prev = Thread.currentThread().getContextClassLoader();
    try {
      ClassLoader connCl = c.getClass().getClassLoader();
      if (connCl != null) Thread.currentThread().setContextClassLoader(connCl);
    List<Map<String, Object>> rows = new ArrayList<>();
    try (ResultSet rs = c.getMetaData().getTables(catalog, schema, "%", types)) {
      while (rs.next()) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("name", rs.getString("TABLE_NAME"));
        row.put("type", rs.getString("TABLE_TYPE"));
        row.put("schema", rs.getString("TABLE_SCHEM"));
        row.put("catalog", rs.getString("TABLE_CAT"));
        rows.add(row);
      }
    } catch (SQLException sqe) { throw sqlError(sqe); }
    return single("rows", rows);
    } finally { Thread.currentThread().setContextClassLoader(prev); }
  }

  private Map<String, Object> metaColumns(JsonNode p) {
    String connId = req(p, "connectionId");
    String catalog = optString(p, "catalog", null);
    String schema = optString(p, "schema", null);
    String table = req(p, "table");
    Connection c = conns.get(connId);
    if (c == null) throw new RpcError("CONNECTION_NOT_FOUND", connId);

    ClassLoader prev = Thread.currentThread().getContextClassLoader();
    try {
      ClassLoader connCl = c.getClass().getClassLoader();
      if (connCl != null) Thread.currentThread().setContextClassLoader(connCl);
    List<Map<String, Object>> rows = new ArrayList<>();
    try (ResultSet rs = c.getMetaData().getColumns(catalog, schema, table, "%")) {
      while (rs.next()) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("name", rs.getString("COLUMN_NAME"));
        row.put("dataType", rs.getInt("DATA_TYPE"));
        row.put("typeName", rs.getString("TYPE_NAME"));
        row.put("size", rs.getInt("COLUMN_SIZE"));
        row.put("digits", rs.getInt("DECIMAL_DIGITS"));
        row.put("nullable", rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls);
        row.put("defaultVal", rs.getString("COLUMN_DEF"));
        row.put("position", rs.getInt("ORDINAL_POSITION"));
        rows.add(row);
      }
    } catch (SQLException sqe) { throw sqlError(sqe); }
    return single("rows", rows);
    } finally { Thread.currentThread().setContextClassLoader(prev); }
  }

  private Map<String, Object> metaPrimaryKeys(JsonNode p) {
    String connId = req(p, "connectionId");
    String catalog = optString(p, "catalog", null);
    String schema = optString(p, "schema", null);
    String table = req(p, "table");
    Connection c = conns.get(connId);
    if (c == null) throw new RpcError("CONNECTION_NOT_FOUND", connId);

    ClassLoader prev = Thread.currentThread().getContextClassLoader();
    try {
      ClassLoader connCl = c.getClass().getClassLoader();
      if (connCl != null) Thread.currentThread().setContextClassLoader(connCl);
    List<String> cols = new ArrayList<>();
    try (ResultSet rs = c.getMetaData().getPrimaryKeys(catalog, schema, table)) {
      // collect and order by KEY_SEQ
      List<Map<String, Object>> raw = new ArrayList<>();
      while (rs.next()) {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("name", rs.getString("COLUMN_NAME"));
        r.put("seq", rs.getShort("KEY_SEQ"));
        raw.add(r);
      }
      raw.sort((a, b) -> ((Short) a.get("seq")).compareTo((Short) b.get("seq")));
      for (Map<String, Object> r : raw) cols.add((String) r.get("name"));
    } catch (SQLException sqe) { throw sqlError(sqe); }
    return single("cols", cols);
    } finally { Thread.currentThread().setContextClassLoader(prev); }
  }

  // DatabaseMetaData.getSchemas — 스키마(=user) 목록. catalog 정보도 함께.
  private Map<String, Object> metaSchemas(JsonNode p) {
    String connId = req(p, "connectionId");
    Connection c = conns.get(connId);
    if (c == null) throw new RpcError("CONNECTION_NOT_FOUND", connId);
    ClassLoader prev = Thread.currentThread().getContextClassLoader();
    try {
      ClassLoader connCl = c.getClass().getClassLoader();
      if (connCl != null) Thread.currentThread().setContextClassLoader(connCl);
      List<Map<String, Object>> rows = new ArrayList<>();
      try (ResultSet rs = c.getMetaData().getSchemas()) {
        while (rs.next()) {
          Map<String, Object> row = new LinkedHashMap<>();
          row.put("schema", rs.getString("TABLE_SCHEM"));
          try { row.put("catalog", rs.getString("TABLE_CATALOG")); } catch (Throwable ignore) {}
          rows.add(row);
        }
      } catch (SQLException sqe) { throw sqlError(sqe); }
      return single("rows", rows);
    } finally { Thread.currentThread().setContextClassLoader(prev); }
  }

  // 지원되는 테이블 타입 목록 (TABLE/VIEW/SYSTEM TABLE/SEQUENCE/SYNONYM 등 — 드라이버마다 다름)
  private Map<String, Object> metaTableTypes(JsonNode p) {
    String connId = req(p, "connectionId");
    Connection c = conns.get(connId);
    if (c == null) throw new RpcError("CONNECTION_NOT_FOUND", connId);
    ClassLoader prev = Thread.currentThread().getContextClassLoader();
    try {
      ClassLoader connCl = c.getClass().getClassLoader();
      if (connCl != null) Thread.currentThread().setContextClassLoader(connCl);
      List<String> types = new ArrayList<>();
      try (ResultSet rs = c.getMetaData().getTableTypes()) {
        while (rs.next()) types.add(rs.getString(1));
      } catch (SQLException sqe) { throw sqlError(sqe); }
      return single("types", types);
    } finally { Thread.currentThread().setContextClassLoader(prev); }
  }

  private Map<String, Object> metaFunctions(JsonNode p) {
    String connId = req(p, "connectionId");
    String catalog = optString(p, "catalog", null);
    String schema = optString(p, "schema", null);
    Connection c = conns.get(connId);
    if (c == null) throw new RpcError("CONNECTION_NOT_FOUND", connId);
    ClassLoader prev = Thread.currentThread().getContextClassLoader();
    try {
      ClassLoader connCl = c.getClass().getClassLoader();
      if (connCl != null) Thread.currentThread().setContextClassLoader(connCl);
      List<Map<String, Object>> rows = new ArrayList<>();
      try (ResultSet rs = c.getMetaData().getFunctions(catalog, schema, "%")) {
        while (rs.next()) {
          Map<String, Object> row = new LinkedHashMap<>();
          row.put("name", rs.getString("FUNCTION_NAME"));
          rows.add(row);
        }
      } catch (Throwable t) { /* 일부 드라이버 getFunctions 미지원 — 빈 목록 */ }
      return single("rows", rows);
    } finally { Thread.currentThread().setContextClassLoader(prev); }
  }

  private Map<String, Object> metaProcedures(JsonNode p) {
    String connId = req(p, "connectionId");
    String catalog = optString(p, "catalog", null);
    String schema = optString(p, "schema", null);
    Connection c = conns.get(connId);
    if (c == null) throw new RpcError("CONNECTION_NOT_FOUND", connId);
    ClassLoader prev = Thread.currentThread().getContextClassLoader();
    try {
      ClassLoader connCl = c.getClass().getClassLoader();
      if (connCl != null) Thread.currentThread().setContextClassLoader(connCl);
      List<Map<String, Object>> rows = new ArrayList<>();
      try (ResultSet rs = c.getMetaData().getProcedures(catalog, schema, "%")) {
        while (rs.next()) {
          Map<String, Object> row = new LinkedHashMap<>();
          row.put("name", rs.getString("PROCEDURE_NAME"));
          rows.add(row);
        }
      } catch (Throwable t) { /* 미지원 — 빈 목록 */ }
      return single("rows", rows);
    } finally { Thread.currentThread().setContextClassLoader(prev); }
  }

  private Map<String, Object> metaIndexes(JsonNode p) {
    String connId = req(p, "connectionId");
    String catalog = optString(p, "catalog", null);
    String schema = optString(p, "schema", null);
    String table = req(p, "table");
    Connection c = conns.get(connId);
    if (c == null) throw new RpcError("CONNECTION_NOT_FOUND", connId);
    ClassLoader prev = Thread.currentThread().getContextClassLoader();
    try {
      ClassLoader connCl = c.getClass().getClassLoader();
      if (connCl != null) Thread.currentThread().setContextClassLoader(connCl);
      // INDEX_NAME 별로 컬럼 모음
      LinkedHashMap<String, List<String>> byIndex = new LinkedHashMap<>();
      try (ResultSet rs = c.getMetaData().getIndexInfo(catalog, schema, table, false, false)) {
        while (rs.next()) {
          String idx = rs.getString("INDEX_NAME");
          if (idx == null) continue;
          String col = rs.getString("COLUMN_NAME");
          byIndex.computeIfAbsent(idx, k -> new ArrayList<>());
          if (col != null) byIndex.get(idx).add(col);
        }
      } catch (Throwable t) { /* 미지원 — 빈 목록 */ }
      List<Map<String, Object>> rows = new ArrayList<>();
      for (Map.Entry<String, List<String>> e : byIndex.entrySet()) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("name", e.getKey());
        row.put("columns", e.getValue());
        rows.add(row);
      }
      return single("rows", rows);
    } finally { Thread.currentThread().setContextClassLoader(prev); }
  }

  // DatabaseMetaData.getProcedureColumns — DBeaver 가 사용하는 표준 JDBC API.
  // columnType: 1=IN, 2=INOUT, 3=RESULT, 4=OUT, 5=RETURN
  private Map<String, Object> metaProcedureColumns(JsonNode p) {
    String connId = req(p, "connectionId");
    String catalog = optString(p, "catalog", null);
    String schema = optString(p, "schema", null);
    String procName = req(p, "procedureName");
    Connection c = conns.get(connId);
    if (c == null) throw new RpcError("CONNECTION_NOT_FOUND", connId);
    ClassLoader prev = Thread.currentThread().getContextClassLoader();
    try {
      ClassLoader connCl = c.getClass().getClassLoader();
      if (connCl != null) Thread.currentThread().setContextClassLoader(connCl);
      List<Map<String, Object>> rows = new ArrayList<>();
      try (ResultSet rs = c.getMetaData().getProcedureColumns(catalog, schema, procName, "%")) {
        int seq = 0;
        while (rs.next()) {
          seq++;
          Map<String, Object> row = new LinkedHashMap<>();
          row.put("name", rs.getString("COLUMN_NAME"));
          row.put("order", seq);
          row.put("columnType", rs.getInt("COLUMN_TYPE"));
          row.put("inOut", columnTypeLabel(rs.getInt("COLUMN_TYPE")));
          row.put("dataType", rs.getInt("DATA_TYPE"));
          row.put("typeName", rs.getString("TYPE_NAME"));
          row.put("length", rs.getInt("LENGTH"));
          row.put("precision", rs.getInt("PRECISION"));
          row.put("scale", rs.getInt("SCALE"));
          row.put("nullable", rs.getInt("NULLABLE") != DatabaseMetaData.procedureNoNulls);
          rows.add(row);
        }
      } catch (SQLException sqe) { throw sqlError(sqe); }
      return single("rows", rows);
    } finally { Thread.currentThread().setContextClassLoader(prev); }
  }

  // JDBC 4.0 — getFunctionColumns (함수 파라미터 + RETURN_VALUE).
  // columnType: 1=IN, 2=INOUT, 3=OUT, 4=RETURN, 5=RESULT
  private Map<String, Object> metaFunctionColumns(JsonNode p) {
    String connId = req(p, "connectionId");
    String catalog = optString(p, "catalog", null);
    String schema = optString(p, "schema", null);
    String funcName = req(p, "functionName");
    Connection c = conns.get(connId);
    if (c == null) throw new RpcError("CONNECTION_NOT_FOUND", connId);
    ClassLoader prev = Thread.currentThread().getContextClassLoader();
    try {
      ClassLoader connCl = c.getClass().getClassLoader();
      if (connCl != null) Thread.currentThread().setContextClassLoader(connCl);
      List<Map<String, Object>> rows = new ArrayList<>();
      try (ResultSet rs = c.getMetaData().getFunctionColumns(catalog, schema, funcName, "%")) {
        int seq = 0;
        while (rs.next()) {
          seq++;
          Map<String, Object> row = new LinkedHashMap<>();
          row.put("name", rs.getString("COLUMN_NAME"));
          row.put("order", seq);
          row.put("columnType", rs.getInt("COLUMN_TYPE"));
          row.put("inOut", functionColumnTypeLabel(rs.getInt("COLUMN_TYPE")));
          row.put("dataType", rs.getInt("DATA_TYPE"));
          row.put("typeName", rs.getString("TYPE_NAME"));
          row.put("length", rs.getInt("LENGTH"));
          row.put("precision", rs.getInt("PRECISION"));
          row.put("scale", rs.getInt("SCALE"));
          row.put("nullable", rs.getInt("NULLABLE") != DatabaseMetaData.functionNoNulls);
          rows.add(row);
        }
      } catch (Throwable t) { /* getFunctionColumns 미지원 드라이버 — 빈 목록 */ }
      return single("rows", rows);
    } finally { Thread.currentThread().setContextClassLoader(prev); }
  }

  private static String columnTypeLabel(int t) {
    // DatabaseMetaData.procedureColumn* 상수
    if (t == DatabaseMetaData.procedureColumnIn)     return "IN";
    if (t == DatabaseMetaData.procedureColumnInOut)  return "INOUT";
    if (t == DatabaseMetaData.procedureColumnOut)    return "OUT";
    if (t == DatabaseMetaData.procedureColumnReturn) return "RETURN";
    if (t == DatabaseMetaData.procedureColumnResult) return "RESULTSET";
    return "?";
  }
  private static String functionColumnTypeLabel(int t) {
    if (t == DatabaseMetaData.functionColumnIn)     return "IN";
    if (t == DatabaseMetaData.functionColumnInOut)  return "INOUT";
    if (t == DatabaseMetaData.functionColumnOut)    return "OUT";
    if (t == DatabaseMetaData.functionReturn)       return "RESULTSET";
    if (t == DatabaseMetaData.functionColumnResult) return "RESULT";
    return "?";
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private static void serializeResultSet(ResultSet rs, int maxRows, Map<String, Object> out) throws SQLException {
    ResultSetMetaData md = rs.getMetaData();
    int n = md.getColumnCount();
    List<String> cols = new ArrayList<>(n);
    List<String> types = new ArrayList<>(n);
    for (int i = 1; i <= n; i++) {
      cols.add(md.getColumnLabel(i));
      types.add(md.getColumnTypeName(i));
    }
    List<List<String>> rows = new ArrayList<>();
    boolean truncated = false;
    while (rs.next()) {
      if (rows.size() >= maxRows) { truncated = true; break; }
      List<String> row = new ArrayList<>(n);
      for (int i = 1; i <= n; i++) {
        Object v = rs.getObject(i);
        row.add(v == null ? "" : v.toString());
      }
      rows.add(row);
    }
    out.put("columns", cols);
    out.put("types", types);
    out.put("rows", rows);
    out.put("truncated", truncated);
  }

  private static String req(JsonNode p, String key) {
    if (p == null || p.get(key) == null || p.get(key).isNull()) {
      throw new RpcError("INVALID_REQUEST", "missing param: " + key);
    }
    return p.get(key).asText();
  }
  private static String optString(JsonNode p, String key, String def) {
    if (p == null) return def;
    JsonNode n = p.get(key);
    return (n == null || n.isNull()) ? def : n.asText();
  }
  private static int optInt(JsonNode p, String key, int def) {
    if (p == null) return def;
    JsonNode n = p.get(key);
    return (n == null || n.isNull()) ? def : n.asInt(def);
  }
  private static String[] optStringArray(JsonNode p, String key) {
    if (p == null) return null;
    JsonNode n = p.get(key);
    if (n == null || !n.isArray() || n.size() == 0) return null;
    String[] out = new String[n.size()];
    for (int i = 0; i < n.size(); i++) out[i] = n.get(i).asText();
    return out;
  }
  private static Map<String, Object> single(String k, Object v) {
    Map<String, Object> m = new LinkedHashMap<>(); m.put(k, v); return m;
  }

  private static String safeCatalog(Connection c) {
    try { return c.getCatalog(); } catch (Throwable t) { return null; }
  }
  private static String safeSchema(Connection c) {
    try { return c.getSchema(); } catch (Throwable t) { return null; }
  }

  private static RpcError sqlError(SQLException sqe) {
    RpcError re = new RpcError("SQL_ERROR", sqe.getMessage() != null ? sqe.getMessage() : sqe.toString());
    re.sqlState = sqe.getSQLState();
    re.vendorCode = sqe.getErrorCode();
    return re;
  }
}
