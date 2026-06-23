# Bundled JDBC drivers

이 디렉토리는 `scripts/download-jdbc-drivers.js` 가 생성/갱신합니다.
JAR 자체는 git 추적에서 제외 (.gitignore) 됩니다.

| File | Maven coordinate | License |
| --- | --- | --- |
| postgresql.jar | org.postgresql:postgresql | BSD-2 |
| mariadb.jar    | org.mariadb.jdbc:mariadb-java-client | LGPL-2.1 |
| mssql.jar      | com.microsoft.sqlserver:mssql-jdbc | MIT |
| sqlite.jar     | org.xerial:sqlite-jdbc | Apache-2.0 |
| altibase-6.jar | user-provided Altibase.jar for Altibase 6.x | Altibase vendor license |

Oracle ojdbc 는 OTN 라이선스 제약으로 번들하지 않습니다. 사용자가 직접 추가하세요.
