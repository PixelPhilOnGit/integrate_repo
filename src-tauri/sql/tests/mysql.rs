//! MySQL 的集成测试：打真实例。
//!
//! 服务由 `common` 自己拉起（整个测试二进制共用一个，见那边的说明）。

mod common;

use common::Mysql;
use devtoolkit_sql::{ConnectionConfig, ConnectionRegistry, SqlError, SqlKind};

const ID: &str = "my1";
const TEST_DB: &str = "devtoolkit_test";

fn config(port: u16) -> ConnectionConfig {
    ConnectionConfig {
        kind: SqlKind::Mysql,
        host: "127.0.0.1".to_string(),
        port,
        username: "root".to_string(),
        // 夹具用 --initialize-insecure 建实例，root 没密码
        password: None,
        database: Some(TEST_DB.to_string()),
    }
}

/// 建测试库（幂等）。
///
/// 抽成独立的函数是因为**忘了调它**会导致一个很难懂的错：
/// 连的时候指定了不存在的库，MySQL 直接报 `Unknown database`。
/// MySQL 连的时候可以不指定库，但那样 `information_schema` 的查询会用 NULL 比较，
/// 什么都查不到 —— 所以每个用例都得先建库。
fn ensure_test_db() {
    let server = Mysql::shared();
    common::mysql_exec(server.port(), &format!("CREATE DATABASE IF NOT EXISTS {TEST_DB}"));
}

async fn connected() -> ConnectionRegistry {
    let server = Mysql::shared();
    ensure_test_db();

    let registry = ConnectionRegistry::new();
    registry
        .connect(ID, &config(server.port()))
        .await
        .expect("应该能连上刚起的 MySQL");
    registry
}

fn table_name(tag: &str) -> String {
    format!("t_{tag}")
}

async fn with_table(tag: &str, columns: &str, rows: &str) -> ConnectionRegistry {
    let registry = connected().await;
    let table = table_name(tag);

    registry.query(ID, &format!("DROP TABLE IF EXISTS {table}")).await.unwrap();
    registry
        .query(ID, &format!("CREATE TABLE {table} ({columns})"))
        .await
        .unwrap();
    if !rows.is_empty() {
        registry.query(ID, &format!("INSERT INTO {table} VALUES {rows}")).await.unwrap();
    }

    registry
}

// ------------------------------------------------------------------ 连接

#[tokio::test]
async fn connect_reports_server_info() {
    let server = Mysql::shared();
    ensure_test_db();

    let registry = ConnectionRegistry::new();

    let info = registry.connect(ID, &config(server.port())).await.unwrap();

    assert_eq!(info.kind, "mysql");
    assert_eq!(info.database, TEST_DB);
    assert!(info.version.starts_with('8'), "版本号看着不对：{}", info.version);
}

#[tokio::test]
async fn connection_refused_is_a_connect_error() {
    let registry = ConnectionRegistry::new();
    let err = registry
        .connect(ID, &ConnectionConfig { port: 1, ..config(1) })
        .await
        .expect_err("应该连不上");

    assert!(matches!(err, SqlError::Connect { .. }), "实际是 {err:?}");
}

// ------------------------------------------------------------------ 查询

#[tokio::test]
async fn select_returns_columns_and_rows() {
    let registry = with_table("sel", "id INT, name VARCHAR(50)", "(1, '张三'), (2, '李四')").await;

    let result = registry
        .query(ID, &format!("SELECT id, name FROM {} ORDER BY id", table_name("sel")))
        .await
        .unwrap();

    assert!(result.error.is_none(), "{:?}", result.error);
    assert_eq!(
        result.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        vec!["id", "name"]
    );
    assert_eq!(result.columns[0].type_name, "long"); // MYSQL_TYPE_LONG
    assert_eq!(result.rows[0][0].text.as_deref(), Some("1"));
    assert_eq!(result.rows[0][1].text.as_deref(), Some("张三"));
}

#[tokio::test]
async fn null_and_empty_string_are_distinguishable() {
    let registry = with_table("null", "a VARCHAR(10), b VARCHAR(10)", "(NULL, '')").await;

    let result = registry.query(ID, &format!("SELECT a, b FROM {}", table_name("null"))).await.unwrap();

    assert_eq!(result.rows[0][0].text, None);
    assert_eq!(result.rows[0][1].text.as_deref(), Some(""));
}

/// **DATE 和 DATETIME 要能分出来。**
///
/// 协议给的都是一串「年月日时分秒」，光看值分不出 `2026-09-17` 和
/// `2026-09-17 00:00:00` —— 得看列类型。这条守着那个判断。
#[tokio::test]
async fn date_and_datetime_render_differently() {
    let registry = with_table(
        "dates",
        "d DATE, dt DATETIME",
        "('2026-09-17', '2026-09-17 09:12:33')",
    )
    .await;

    let result = registry
        .query(ID, &format!("SELECT d, dt FROM {}", table_name("dates")))
        .await
        .unwrap();

    assert_eq!(result.rows[0][0].text.as_deref(), Some("2026-09-17"), "DATE 只该显示日期");
    assert_eq!(
        result.rows[0][1].text.as_deref(),
        Some("2026-09-17 09:12:33"),
        "DATETIME 该显示到秒"
    );
}

/// MySQL 的 TIME 可以超过 24 小时（用天数表示），要拼回总小时数
#[tokio::test]
async fn time_over_24_hours_is_folded_back() {
    let registry = with_table("times", "t TIME", "('36:30:00')").await;

    let result = registry.query(ID, &format!("SELECT t FROM {}", table_name("times"))).await.unwrap();
    assert_eq!(result.rows[0][0].text.as_deref(), Some("36:30:00"));
}

#[tokio::test]
async fn sql_errors_are_results_not_failures() {
    let registry = connected().await;

    let result = registry
        .query(ID, "SELECT * FROM 这张表不存在")
        .await
        .expect("引擎拒绝不该让 query 返回 Err");

    let error = result.error.expect("应该有错误信息");
    assert!(
        error.contains("doesn't exist") || error.contains("不存在"),
        "实际：{error}"
    );
    assert!(registry.is_connected(ID).unwrap(), "连接不该被摘掉");

    let ok = registry.query(ID, "SELECT 1").await.unwrap();
    assert!(ok.error.is_none());
}

#[tokio::test]
async fn non_select_statements_report_affected_rows() {
    let registry = with_table("aff", "id INT", "").await;
    let table = table_name("aff");

    let inserted = registry
        .query(ID, &format!("INSERT INTO {table} VALUES (1), (2), (3)"))
        .await
        .unwrap();
    assert_eq!(inserted.affected, Some(3));

    let updated = registry
        .query(ID, &format!("UPDATE {table} SET id = id + 10"))
        .await
        .unwrap();
    assert_eq!(updated.affected, Some(3));
}

#[tokio::test]
async fn huge_results_are_truncated_and_flagged() {
    let registry = connected().await;

    // 递归 CTE 的默认上限是 **1000**（cte_max_recursion_depth），
    // 不改的话这条会报 3636 而不是产出 2000 行 —— 先把上限抬上去。
    // 会话级设置，跑完这条连接就退了，不影响别人
    let raised = registry
        .query(ID, "SET SESSION cte_max_recursion_depth = 5000")
        .await
        .unwrap();
    assert!(raised.error.is_none(), "抬递归上限失败：{:?}", raised.error);

    let result = registry
        .query(
            ID,
            "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2000) \
             SELECT n FROM seq",
        )
        .await
        .unwrap();

    assert!(result.error.is_none(), "{:?}", result.error);
    assert_eq!(result.rows.len(), devtoolkit_sql::MAX_ROWS);
    assert!(result.truncated);
}

// ------------------------------------------------------------------ 元数据

#[tokio::test]
async fn databases_lists_the_server_databases() {
    let registry = connected().await;

    let databases = registry.databases(ID).await.unwrap();

    assert!(databases.contains(&TEST_DB.to_string()), "实际：{databases:?}");
    assert!(databases.contains(&"information_schema".to_string()));
}

/// MySQL 的表列表要**按当前库过滤** —— 不过滤的话会把所有库的表都列出来
#[tokio::test]
async fn tables_lists_only_the_current_database() {
    let registry = with_table("listed", "id INT", "").await;
    let server = Mysql::shared();

    // 在另一个库里也建一张表
    common::mysql_exec(server.port(), "CREATE DATABASE IF NOT EXISTS other_db");
    common::mysql_exec(server.port(), "CREATE TABLE IF NOT EXISTS other_db.别处的表 (id INT)");

    let tables = registry.tables(ID).await.unwrap();
    let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();

    assert!(names.contains(&table_name("listed").as_str()), "实际：{names:?}");
    assert!(
        !names.contains(&"别处的表"),
        "当前库是 {TEST_DB}，不该列出 other_db 的表：{names:?}"
    );
}

/// MySQL 换库用 `USE`，同一条连接接着用
#[tokio::test]
async fn use_database_switches_on_the_same_connection() {
    let registry = connected().await;
    let server = Mysql::shared();

    common::mysql_exec(server.port(), "CREATE DATABASE IF NOT EXISTS switch_target");
    common::mysql_exec(server.port(), "CREATE TABLE IF NOT EXISTS switch_target.目标库的表 (id INT)");

    let info = registry.use_database(ID, "switch_target").await.unwrap();
    assert_eq!(info.database, "switch_target");

    let tables = registry.tables(ID).await.unwrap();
    assert!(
        tables.iter().any(|t| t.name == "目标库的表"),
        "换库之后该看到新库的表：{:?}",
        tables.iter().map(|t| &t.name).collect::<Vec<_>>()
    );

    // 换回去
    registry.use_database(ID, TEST_DB).await.unwrap();
    let tables = registry.tables(ID).await.unwrap();
    assert!(!tables.iter().any(|t| t.name == "目标库的表"));
}

#[tokio::test]
async fn disconnect_forgets_the_connection() {
    let registry = connected().await;

    assert!(registry.disconnect(ID).unwrap());
    assert!(!registry.is_connected(ID).unwrap());

    let err = registry.query(ID, "SELECT 1").await.expect_err("断开之后不该能查询");
    assert!(matches!(err, SqlError::NotConnected { .. }), "实际是 {err:?}");
}
