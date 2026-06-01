package com.pepe.jdbc;

/** Typed RPC error — handlers throw this to signal a structured failure. */
public class RpcError extends RuntimeException {
  public final String code;
  public String sqlState;
  public Integer vendorCode;
  public RpcError(String code, String message) { super(message); this.code = code; }
}
