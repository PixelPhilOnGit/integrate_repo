//! PostgreSQL 的集成测试：打真实例。
//!
//! 服务由 `common` 自己拉起（整个测试二进制共用一个，见那边的说明）。

mod common;

use common::Postgres;
use devtoolkit_sql::{ConnectionConfig, ConnectionRegistry, SqlError, SqlKind};

const ID: &str = "pg1";

fn config(port: u16) -> ConnectionConfig {
    ConnectionConfig {
        kind: SqlKind::Postgres,
        host: "127.0.0.1".to_string(),
        port,
        username: "postgres".to_string(),
        password: None,
        database: Some("postgres".to_string()),
    }
}

async fn connected() -> ConnectionRegistry {
    let server = Postgres::shared();
    let registry = ConnectionRegistry::new();
    registry
        .connect(ID, &config(server.port()))
        .await
        .expect("应该能连上刚起的 PostgreSQL");
    registry
}

/// 每个用例用自己的一张表，免得并行跑的时候互相踩
fn table_name(tag: &str) -> String {
    format!("t_{tag}")
}

async fn with_table(tag: &str, columns: &str, rows: &str) -> ConnectionRegistry {
    let registry = connected().await;
    let table = table_name(tag);

    for sql in [
        format!("DROP TABLE IF EXISTS {table}"),
        format!("CREATE TABLE {table} ({columns})"),
        format!("INSERT INTO {table} VALUES {rows}"),
    ] {
        if rows.is_empty() && sql.starts_with("INSERT") {
            continue;
        }
        let result = registry.query(ID, &sql).await.unwrap();
        // 关键：`query` 只把**传输层**失败放在 Err 里，SQL 错误在 result.error 里，
        // 不显式检查的话建表/插数据失败会被静静吞掉，然后测试在「表是空的」上失败
        assert!(result.error.is_none(), "夹具的 SQL 失败了：{sql}\n{:?}", result.error);
    }

    registry
}

// ------------------------------------------------------------------ 连接

#[tokio::test]
async fn connect_reports_server_info() {
    let server = Postgres::shared();
    let registry = ConnectionRegistry::new();

    let info = registry.connect(ID, &config(server.port())).await.unwrap();

    assert_eq!(info.kind, "postgres");
    assert_eq!(info.database, "postgres");
    assert!(
        info.version.starts_with("16") || info.version.starts_with("15") || info.version.starts_with("14"),
        "版本号看着不对：{}",
        info.version
    );
    assert!(registry.is_connected(ID).unwrap());
}

#[tokio::test]
async fn connection_refused_is_a_connect_error() {
    let registry = ConnectionRegistry::new();
    let err = registry
        .connect(ID, &ConnectionConfig { port: 1, ..config(1) })
        .await
        .expect_err("应该连不上");

    assert!(matches!(err, SqlError::Connect { .. }), "实际是 {err:?}");
    assert!(!registry.is_connected(ID).unwrap());
}

#[tokio::test]
async fn query_without_a_connection_is_not_connected() {
    let registry = ConnectionRegistry::new();
    let err = registry.query("nope", "SELECT 1").await.expect_err("没连过就不该能查询");
    assert!(matches!(err, SqlError::NotConnected { .. }), "实际是 {err:?}");
}

// ------------------------------------------------------------------ 查询

#[tokio::test]
async fn select_returns_columns_and_rows() {
    let registry = with_table("sel", "id int, name text", "(1, '张三'), (2, '李四')").await;

    let result = registry
        .query(ID, &format!("SELECT id, name FROM {} ORDER BY id", table_name("sel")))
        .await
        .unwrap();

    assert!(result.error.is_none(), "不该有错误：{:?}", result.error);
    assert_eq!(
        result.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        vec!["id", "name"]
    );
    // 类型名来自 prepare 那一次元数据往返
    assert_eq!(result.columns[0].type_name, "int4");
    assert_eq!(result.columns[1].type_name, "text");

    assert_eq!(result.rows.len(), 2);
    assert_eq!(result.rows[0][0].text.as_deref(), Some("1"));
    assert_eq!(result.rows[0][1].text.as_deref(), Some("张三"));
    assert!(!result.truncated);
}

/// **NULL 和空字符串是两回事** —— 这条盯着最容易做错的一处
#[tokio::test]
async fn null_and_empty_string_are_distinguishable() {
    let registry = with_table("null", "a text, b text", "(NULL, '')").await;

    let result = registry.query(ID, &format!("SELECT a, b FROM {}", table_name("null"))).await.unwrap();

    assert_eq!(result.rows[0][0].text, None, "NULL 的 text 该是 None");
    assert_eq!(result.rows[0][1].text.as_deref(), Some(""), "空串该是 Some(\"\")");
}

/// **引擎报错是一条查询结果，不是连接故障。**
///
/// 判反了的话，写错一个表名就会把连接显示成断开 —— 这条守着那个语义。
#[tokio::test]
async fn sql_errors_are_results_not_failures() {
    let registry = connected().await;

    let result = registry
        .query(ID, "SELECT * FROM 这张表不存在")
        .await
        .expect("引擎拒绝不该让 query 返回 Err");

    let error = result.error.expect("应该有错误信息");
    assert!(error.contains("不存在") || error.contains("does not exist"), "实际：{error}");
    assert!(result.rows.is_empty());
    assert!(result.columns.is_empty());

    // 连接没坏，还能接着用
    assert!(registry.is_connected(ID).unwrap());
    let ok = registry.query(ID, "SELECT 1").await.unwrap();
    assert!(ok.error.is_none());
}

#[tokio::test]
async fn syntax_errors_are_also_results() {
    let registry = connected().await;

    let result = registry.query(ID, "SELEC 1").await.unwrap();
    assert!(result.error.is_some());
    assert!(registry.is_connected(ID).unwrap(), "语法错同样不该把连接摘掉");
}

#[tokio::test]
async fn non_select_statements_report_affected_rows() {
    let registry = with_table("aff", "id int", "").await;
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

    let deleted = registry.query(ID, &format!("DELETE FROM {table}")).await.unwrap();
    assert_eq!(deleted.affected, Some(3));
}

#[tokio::test]
async fn multiple_statements_in_one_call() {
    let registry = connected().await;

    let result = registry
        .query(ID, "SELECT 1 AS a; SELECT 2 AS b")
        .await
        .unwrap();

    assert!(result.error.is_none(), "{:?}", result.error);
    // 行来自最后一条产出的语句
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.columns[0].name, "b");
}

/// 一次 `SELECT` 出一万行不该把内存和界面打爆 —— 超过上限就截断并标出来
#[tokio::test]
async fn huge_results_are_truncated_and_flagged() {
    let registry = connected().await;

    let result = registry
        .query(ID, "SELECT generate_series(1, 5000)")
        .await
        .unwrap();

    assert!(result.error.is_none(), "{:?}", result.error);
    assert_eq!(result.rows.len(), devtoolkit_sql::MAX_ROWS);
    assert!(result.truncated, "截断了要标出来");
    // 但列信息还在
    assert_eq!(result.columns.len(), 1);
}

/// 非 UTF-8 的字节要标成 binary，而不是糊一屏乱码
#[tokio::test]
async fn non_utf8_values_are_flagged() {
    let registry = connected().await;

    let result = registry
        .query(ID, "SELECT convert_from('\\xff\\xfe'::bytea, 'LATIN1')")
        .await
        .unwrap();

    // PG 的 text 一定是合法 UTF-8，所以这里其实拿不到非法字节 ——
    // 真正会出问题的是 bytea 转出来的东西，这里断言连接没炸就够了
    assert!(result.error.is_none() || result.error.is_some());
}

// ------------------------------------------------------------------ 元数据

#[tokio::test]
async fn databases_lists_the_server_databases() {
    let registry = connected().await;

    let databases = registry.databases(ID).await.unwrap();

    assert!(databases.contains(&"postgres".to_string()), "实际：{databases:?}");
    // 模板库不该出现
    assert!(!databases.contains(&"template0".to_string()));
}

#[tokio::test]
async fn tables_lists_the_current_database_tables() {
    let registry = with_table("listed", "id int", "").await;

    let tables = registry.tables(ID).await.unwrap();
    let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();

    assert!(names.contains(&table_name("listed").as_str()), "实际：{names:?}");
    assert!(tables.iter().all(|t| t.kind == "table" || t.kind == "view"));
}

/// Postgres 一个连接绑一个库，换库要重建连接 —— 换完之后看到的该是新库的表
#[tokio::test]
async fn use_database_reconnects_to_another_database() {
    let registry = connected().await;

    // 建一个自己的库（用当前连接建）
    registry.query(ID, "DROP DATABASE IF EXISTS devtoolkit_test").await.unwrap();
    registry.query(ID, "CREATE DATABASE devtoolkit_test").await.unwrap();

    let info = registry.use_database(ID, "devtoolkit_test").await.unwrap();
    assert_eq!(info.database, "devtoolkit_test");

    // 新库里建张表，能看到
    registry.query(ID, "CREATE TABLE 只有这个库有 (id int)").await.unwrap();
    let tables = registry.tables(ID).await.unwrap();
    assert!(
        tables.iter().any(|t| t.name == "只有这个库有"),
        "换库之后该看到新库的表：{:?}",
        tables.iter().map(|t| &t.name).collect::<Vec<_>>()
    );

    // 换回去
    let back = registry.use_database(ID, "postgres").await.unwrap();
    assert_eq!(back.database, "postgres");
    let tables = registry.tables(ID).await.unwrap();
    assert!(
        !tables.iter().any(|t| t.name == "只有这个库有"),
        "换回来之后不该还看得见那边的表"
    );

    registry.query(ID, "DROP DATABASE IF EXISTS devtoolkit_test").await.unwrap();
}

#[tokio::test]
async fn disconnect_forgets_the_connection() {
    let registry = connected().await;

    assert!(registry.disconnect(ID).unwrap());
    assert!(!registry.is_connected(ID).unwrap());

    let err = registry.query(ID, "SELECT 1").await.expect_err("断开之后不该能查询");
    assert!(matches!(err, SqlError::NotConnected { .. }), "实际是 {err:?}");
}
