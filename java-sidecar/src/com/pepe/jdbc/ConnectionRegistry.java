package com.pepe.jdbc;

import java.sql.Connection;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/** Live JDBC connections keyed by connection id (renderer-supplied). */
public final class ConnectionRegistry {
  private final ConcurrentMap<String, Connection> conns = new ConcurrentHashMap<>();

  public Connection get(String id) { return conns.get(id); }
  public void put(String id, Connection c) { conns.put(id, c); }
  public Connection remove(String id) { return conns.remove(id); }

  public int size() { return conns.size(); }
}
