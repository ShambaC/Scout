use rusqlite::{Connection, params_from_iter, types::{Value as Sql, ValueRef}};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{collections::HashMap, path::PathBuf, sync::{Arc, Mutex, Once}, time::Duration};
use tauri::State;

pub struct Db {
    pub data_dir: PathBuf,
    pub projects_dir: PathBuf,
    conns: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
}

#[derive(Deserialize)]
pub struct Stmt {
    sql: String,
    #[serde(default)]
    params: Vec<Value>,
}

#[derive(Serialize)]
pub struct ExecResult {
    changes: usize,
    last_insert_rowid: i64,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn register_vec() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    });
}

impl Db {
    pub fn new(data_dir: PathBuf, projects_dir: PathBuf) -> Self {
        register_vec();
        Db { data_dir, projects_dir, conns: Default::default() }
    }

    fn path(&self, name: &str) -> Result<PathBuf, String> {
        if name == "app" {
            return Ok(self.data_dir.join("app.sqlite"));
        }
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
            return Err(format!("invalid db name: {name}"));
        }
        Ok(self.projects_dir.join(format!("{name}.sqlite")))
    }

    fn conn(&self, name: &str) -> Result<Arc<Mutex<Connection>>, String> {
        let mut m = self.conns.lock().unwrap();
        if let Some(c) = m.get(name) {
            return Ok(c.clone());
        }
        let c = Connection::open(self.path(name)?).map_err(err)?;
        c.busy_timeout(Duration::from_secs(10)).map_err(err)?;
        let schema = if name == "app" { include_str!("schema_app.sql") } else { include_str!("schema_project.sql") };
        c.execute_batch(&format!("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; {schema}"))
            .map_err(err)?;
        let c = Arc::new(Mutex::new(c));
        m.insert(name.to_string(), c.clone());
        Ok(c)
    }
}

fn param(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(Sql::Integer).unwrap_or_else(|| Sql::Real(n.as_f64().unwrap_or(f64::NAN))),
        Value::String(s) => Sql::Text(s.clone()),
        other => Sql::Text(other.to_string()), // arrays/objects as JSON text (e.g. sqlite-vec vectors)
    }
}

fn cell(v: ValueRef) -> Value {
    match v {
        ValueRef::Integer(i) => i.into(),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Null | ValueRef::Blob(_) => Value::Null,
    }
}

#[tauri::command(async)]
pub fn db_query(st: State<Db>, db: String, sql: String, params: Vec<Value>) -> Result<Vec<Map<String, Value>>, String> {
    let c = st.conn(&db)?;
    let c = c.lock().unwrap();
    let mut stmt = c.prepare(&sql).map_err(err)?;
    let cols: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
    let mut rows = stmt.query(params_from_iter(params.iter().map(param))).map_err(err)?;
    let mut out = vec![];
    while let Some(r) = rows.next().map_err(err)? {
        let mut m = Map::new();
        for (i, k) in cols.iter().enumerate() {
            m.insert(k.clone(), cell(r.get_ref(i).map_err(err)?));
        }
        out.push(m);
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn db_exec(st: State<Db>, db: String, sql: String, params: Vec<Value>) -> Result<ExecResult, String> {
    let c = st.conn(&db)?;
    let c = c.lock().unwrap();
    let changes = c.execute(&sql, params_from_iter(params.iter().map(param))).map_err(err)?;
    Ok(ExecResult { changes, last_insert_rowid: c.last_insert_rowid() })
}

#[tauri::command(async)]
pub fn db_batch(st: State<Db>, db: String, statements: Vec<Stmt>) -> Result<(), String> {
    let c = st.conn(&db)?;
    let mut c = c.lock().unwrap();
    let tx = c.transaction().map_err(err)?;
    for s in &statements {
        tx.execute(&s.sql, params_from_iter(s.params.iter().map(param))).map_err(err)?;
    }
    tx.commit().map_err(err)
}

#[tauri::command(async)]
pub fn db_delete_project(st: State<Db>, id: String) -> Result<(), String> {
    let path = st.path(&id)?;
    if id == "app" {
        return Err("refusing to delete the app db".into());
    }
    if let Some(c) = st.conns.lock().unwrap().remove(&id) {
        drop(c.lock().unwrap()); // wait for in-flight use; connection closes when the last Arc drops
    }
    for suffix in ["", "-wal", "-shm"] {
        let mut p = path.clone().into_os_string();
        p.push(suffix);
        match std::fs::remove_file(&p) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(err(e)),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schemas_load_and_vec_works() {
        let d = std::env::temp_dir().join(format!("scout-test-{}", std::process::id()));
        std::fs::create_dir_all(d.join("p")).unwrap();
        let db = Db::new(d.clone(), d.join("p"));
        db.conn("app").unwrap();
        let c = db.conn("proj_1").unwrap();
        let c = c.lock().unwrap();
        c.execute_batch("CREATE VIRTUAL TABLE v USING vec0(embedding float[2]); INSERT INTO v(rowid, embedding) VALUES (1, '[1,2]');").unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM v WHERE embedding MATCH '[1,2]' AND k=1", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        assert!(db.path("../x").is_err());
        let _ = std::fs::remove_dir_all(d);
    }
}
