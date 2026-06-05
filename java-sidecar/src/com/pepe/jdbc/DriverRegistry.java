package com.pepe.jdbc;

import java.io.File;
import java.net.URL;
import java.net.URLClassLoader;
import java.sql.Driver;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Holds JDBC {@link Driver} instances keyed by driver id (the one we coined in
 * the Renderer's drivers.json — e.g. "postgres-builtin"). Each driver gets its
 * own {@link URLClassLoader} so multiple drivers (even with conflicting
 * dependencies) coexist without polluting the system class loader.
 *
 * <p>{@link java.sql.DriverManager} is intentionally NOT used: it requires the
 * driver class to be loaded by the system class loader, which is incompatible
 * with isolated class loaders. We instead instantiate the driver directly and
 * pass connection requests straight to {@link Driver#connect(String, java.util.Properties)}.
 */
public final class DriverRegistry {
  private final Map<String, Driver> drivers = new HashMap<>();
  // Keep the loader per driver — many JDBC drivers do internal Class.forName
  // calls against the thread context class loader (e.g. Altibase loads
  // AltibaseConnection by name from inside connect()). We must set the context
  // CL to the driver's URLClassLoader for the duration of connect/exec or
  // those internal lookups fail with ClassNotFoundException.
  private final Map<String, ClassLoader> classLoaders = new HashMap<>();

  public synchronized Driver getDriver(String id) {
    return drivers.get(id);
  }

  public synchronized ClassLoader getClassLoader(String id) {
    return classLoaders.get(id);
  }

  public synchronized void loadDriver(String id, String className, List<String> jars) {
    // 항상 새 URLClassLoader 로 재구성한다.
    // 캐시 reuse 는 사용자가 Driver Manager 에서 jars 를 변경(예: 누락된 transitive 의존성 추가)했을 때
    // 이전 classloader 가 그대로 남아 NoClassDefFoundError 가 지속되는 문제를 만든다.
    // 기존 Connection 들은 자체 classloader 참조를 들고 있어 계속 동작하므로 안전.

    URL[] urls = new URL[jars.size()];
    for (int i = 0; i < jars.size(); i++) {
      File f = new File(jars.get(i));
      if (!f.isFile()) {
        throw new RpcError("DRIVER_NOT_FOUND", "JAR missing: " + f.getAbsolutePath());
      }
      try { urls[i] = f.toURI().toURL(); }
      catch (Exception e) { throw new RpcError("DRIVER_NOT_FOUND", "bad JAR url: " + f + " (" + e.getMessage() + ")"); }
    }

    // parent = current ClassLoader so the driver can still see the JDK + Jackson.
    URLClassLoader cl = new URLClassLoader(urls, DriverRegistry.class.getClassLoader());
    Class<?> c;
    try { c = Class.forName(className, true, cl); }
    catch (ClassNotFoundException e) { throw new RpcError("DRIVER_NOT_FOUND", "class not found in JARs: " + className); }

    Driver d;
    try { d = (Driver) c.getDeclaredConstructor().newInstance(); }
    catch (Throwable t) { throw new RpcError("DRIVER_NOT_FOUND", "cannot instantiate driver: " + className + " — " + t.getMessage()); }

    drivers.put(id, d);
    classLoaders.put(id, cl);
  }
}
