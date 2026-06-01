package com.pepe.jdbc;

/**
 * PePe JDBC Sidecar entry point — delegates the JSON-RPC loop to {@link Rpc}.
 *
 * <p>Run via {@code java -jar pepe-jdbc.jar}. Jackson dependencies are picked
 * up through the JAR's manifest Class-Path (siblings in the same directory).
 */
public final class Main {
  private Main() {}
  public static void main(String[] args) throws Exception {
    new Rpc(new Handlers()).serve(System.in, System.out, System.err);
  }
}
