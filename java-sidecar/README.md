# PePe JDBC Sidecar

Java process spawned by the Electron main process to drive JDBC connections on
behalf of the SQL Tool. Reads line-delimited JSON-RPC from stdin, writes
responses to stdout. Logs go to stderr.

See `docs/DESIGN_jdbc_sql_tool.md` for the architecture and IPC protocol.

## Layout

```
java-sidecar/
  src/com/pepe/jdbc/Main.java   — entry point
  build/                        — compiled classes (gitignored)
```

The build script `scripts/build-sidecar.js` compiles the sources with `javac`
and packages them into `resources/jdbc-sidecar/pepe-jdbc.jar` (the artifact
shipped with the Electron app).

## Current state (E-2.1 skeleton)

Only the `ping` method is wired. The skeleton has no external dependencies
(no Jackson, no Gradle) so it builds with a plain JDK 8+ install.

```
> {"id":1,"method":"ping"}
< {"id":1,"result":{"ok":true,"version":"0.1.0","javaVersion":"...","javaVendor":"...","os":"..."}}
```

When the full JDBC feature lands (E-4) we will introduce Jackson and a
proper build system (Gradle shadow JAR).

## Building manually

```
# from repo root
node scripts/build-sidecar.js
```

Requires `javac` and `jar` on `PATH` (or `JAVA_HOME` set). JDK 8 or newer.
