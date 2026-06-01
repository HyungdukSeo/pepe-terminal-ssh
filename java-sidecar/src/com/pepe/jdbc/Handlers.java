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
    try { conn = d.connect(url, props); }
    catch (SQLException sqe) { throw sqlError(sqe); }
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
  }

  private Map<String, Object> metaTables(JsonNode p) {
    String connId = req(p, "connectionId");
    String catalog = optString(p, "catalog", null);
    String schema = optString(p, "schema", null);
    String[] types = optStringArray(p, "types");
    Connection c = conns.get(connId);
    if (c == null) throw new RpcError("CONNECTION_NOT_FOUND", connId);

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
  }

  private Map<String, Object> metaColumns(JsonNode p) {
    String connId = req(p, "connectionId");
    String catalog = optString(p, "catalog", null);
    String schema = optString(p, "schema", null);
    String table = req(p, "table");
    Connection c = conns.get(connId);
    if (c == null) throw new RpcError("CONNECTION_NOT_FOUND", connId);

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
  }

  private Map<String, Object> metaPrimaryKeys(JsonNode p) {
    String connId = req(p, "connectionId");
    String catalog = optString(p, "catalog", null);
    String schema = optString(p, "schema", null);
    String table = req(p, "table");
    Connection c = conns.get(connId);
    if (c == null) throw new RpcError("CONNECTION_NOT_FOUND", connId);

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
