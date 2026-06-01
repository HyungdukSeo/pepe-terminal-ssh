package com.pepe.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintStream;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;

/**
 * Line-delimited JSON-RPC server over stdio.
 *
 * <p>Each input line is parsed as a JSON request object: {@code id, method, params}.
 * One JSON response line is emitted per request: {@code id, result} or
 * {@code id, error:{code, message, sqlState?, vendorCode?}}.
 */
public final class Rpc {
  private final Handlers handlers;
  private final ObjectMapper mapper = new ObjectMapper();

  public Rpc(Handlers handlers) { this.handlers = handlers; }

  public void serve(InputStream in, OutputStream out, PrintStream err) throws Exception {
    BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
    PrintWriter pw = new PrintWriter(new OutputStreamWriter(out, StandardCharsets.UTF_8), true);
    err.println("[pepe-jdbc] ready version=" + Handlers.VERSION
        + " java=" + System.getProperty("java.version"));

    String line;
    while ((line = br.readLine()) != null) {
      if (line.trim().isEmpty()) continue;
      pw.println(handle(line));
    }
  }

  String handle(String line) {
    JsonNode req;
    try { req = mapper.readTree(line); }
    catch (Exception e) { return errorResponse(NullNode.getInstance(), "INVALID_REQUEST", "bad JSON: " + e.getMessage(), null, null); }

    JsonNode id = req.get("id");
    if (id == null) id = NullNode.getInstance();
    String method = req.path("method").asText("");
    JsonNode params = req.has("params") ? req.get("params") : NullNode.getInstance();

    try {
      Object result = handlers.dispatch(method, params);
      ObjectNode resp = mapper.createObjectNode();
      resp.set("id", id);
      resp.set("result", mapper.valueToTree(result));
      return mapper.writeValueAsString(resp);
    } catch (RpcError re) {
      return errorResponse(id, re.code, safeMsg(re), re.sqlState, re.vendorCode);
    } catch (Throwable t) {
      return errorResponse(id, "INTERNAL", t.getMessage() != null ? t.getMessage() : t.toString(), null, null);
    }
  }

  private String errorResponse(JsonNode id, String code, String message, String sqlState, Integer vendorCode) {
    ObjectNode resp = mapper.createObjectNode();
    resp.set("id", id);
    ObjectNode err = resp.putObject("error");
    err.put("code", code);
    err.put("message", message == null ? "" : message);
    if (sqlState != null) err.put("sqlState", sqlState);
    if (vendorCode != null) err.put("vendorCode", vendorCode);
    try { return mapper.writeValueAsString(resp); }
    catch (Exception ignore) { return "{\"id\":null,\"error\":{\"code\":\"INTERNAL\",\"message\":\"json fail\"}}"; }
  }

  private static String safeMsg(Throwable t) {
    return t.getMessage() != null ? t.getMessage() : t.toString();
  }
}
