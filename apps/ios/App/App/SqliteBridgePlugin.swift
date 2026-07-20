import Capacitor
import SQLite3

/// System-SQLite database plugin — replaces @capacitor-community/sqlite.
///
/// Links the OS-provided libsqlite3 (`import SQLite3`): plain SQLite with no
/// bundled cryptography, so the app ships no encryption code and is not subject
/// to the SQLCipher export-compliance obligation. The database is a plain
/// unencrypted file in Documents (excluded from device backup in AppDelegate,
/// matching Android's allowBackup="false").
///
/// The JS side (adapters/capacitor.ts) speaks the same wire shape the community
/// plugin did — `{ values }` for query, `{ changes: { changes, lastId } }` for
/// mutate — so the driver rewrite is a thin swap. Bytes cross the JSON bridge as
/// base64 tagged with `blobPrefix`.
@objc(SqliteBridgePlugin)
class SqliteBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "SqliteBridgePlugin"
    let jsName = "TasferSqlite"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "query", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mutate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exec", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "commitTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rollbackTransaction", returnType: CAPPluginReturnPromise),
    ]

    /// Uint8Array params/results are base64 with this prefix on the JSON bridge.
    private static let blobPrefix = "__blob__:"
    /// SQLite must copy bound text/blob bytes (they outlive the bind call).
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    private var db: OpaquePointer?
    /// Serialize every DB access; JS callers issue overlapping async calls.
    private let queue = DispatchQueue(label: "app.tasfer.sqlite")

    @objc func open(_ call: CAPPluginCall) {
        let name = call.getString("database") ?? "tasfer"
        queue.async {
            if self.db != nil { call.resolve(); return }
            let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let path = dir.appendingPathComponent("\(name).db").path
            var handle: OpaquePointer?
            guard sqlite3_open(path, &handle) == SQLITE_OK, let handle else {
                let msg = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
                sqlite3_close(handle)
                call.reject(msg)
                return
            }
            sqlite3_exec(handle, "PRAGMA journal_mode=WAL;", nil, nil, nil)
            sqlite3_exec(handle, "PRAGMA foreign_keys=ON;", nil, nil, nil)
            self.db = handle
            call.resolve()
        }
    }

    @objc func query(_ call: CAPPluginCall) {
        let sql = call.getString("statement") ?? ""
        let values = call.getArray("values") ?? []
        queue.async {
            guard let db = self.db else { call.reject("Database not open"); return }
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
                call.reject(String(cString: sqlite3_errmsg(db))); return
            }
            defer { sqlite3_finalize(stmt) }
            if let err = self.bind(stmt, values) { call.reject(err); return }

            var rows: [[String: Any]] = []
            let cols = sqlite3_column_count(stmt)
            while sqlite3_step(stmt) == SQLITE_ROW {
                var row: [String: Any] = [:]
                for i in 0..<cols {
                    row[String(cString: sqlite3_column_name(stmt, i))] = self.columnValue(stmt, i)
                }
                rows.append(row)
            }
            call.resolve(["values": rows])
        }
    }

    @objc func mutate(_ call: CAPPluginCall) {
        let sql = call.getString("statement") ?? ""
        let values = call.getArray("values") ?? []
        queue.async {
            guard let db = self.db else { call.reject("Database not open"); return }
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
                call.reject(String(cString: sqlite3_errmsg(db))); return
            }
            defer { sqlite3_finalize(stmt) }
            if let err = self.bind(stmt, values) { call.reject(err); return }
            guard sqlite3_step(stmt) == SQLITE_DONE else {
                call.reject(String(cString: sqlite3_errmsg(db))); return
            }
            call.resolve(["changes": [
                "changes": Int(sqlite3_changes(db)),
                "lastId": Int(sqlite3_last_insert_rowid(db)),
            ]])
        }
    }

    @objc func exec(_ call: CAPPluginCall) {
        let sql = call.getString("statements") ?? ""
        queue.async {
            guard let db = self.db else { call.reject("Database not open"); return }
            var errPtr: UnsafeMutablePointer<CChar>?
            // sqlite3_exec runs every semicolon-separated statement in one call,
            // so the multi-statement schema DDL needs no JS-side splitting.
            if sqlite3_exec(db, sql, nil, nil, &errPtr) != SQLITE_OK {
                let msg = errPtr.map { String(cString: $0) } ?? "exec failed"
                sqlite3_free(errPtr)
                call.reject(msg)
                return
            }
            call.resolve()
        }
    }

    @objc func beginTransaction(_ call: CAPPluginCall) { execSimple("BEGIN", call) }
    @objc func commitTransaction(_ call: CAPPluginCall) { execSimple("COMMIT", call) }
    @objc func rollbackTransaction(_ call: CAPPluginCall) { execSimple("ROLLBACK", call) }

    private func execSimple(_ sql: String, _ call: CAPPluginCall) {
        queue.async {
            guard let db = self.db else { call.reject("Database not open"); return }
            if sqlite3_exec(db, sql, nil, nil, nil) != SQLITE_OK {
                call.reject(String(cString: sqlite3_errmsg(db))); return
            }
            call.resolve()
        }
    }

    // MARK: - Binding & reading

    /// Bind positional `?` params. Returns an error message on failure, else nil.
    private func bind(_ stmt: OpaquePointer?, _ values: [Any]) -> String? {
        for (idx, value) in values.enumerated() {
            let i = Int32(idx + 1)
            switch value {
            case is NSNull:
                sqlite3_bind_null(stmt, i)
            case let s as String where s.hasPrefix(Self.blobPrefix):
                guard let data = Data(base64Encoded: String(s.dropFirst(Self.blobPrefix.count))) else {
                    return "Invalid blob parameter"
                }
                _ = data.withUnsafeBytes {
                    sqlite3_bind_blob(stmt, i, $0.baseAddress, Int32(data.count), Self.transient)
                }
            case let s as String:
                sqlite3_bind_text(stmt, i, s, -1, Self.transient)
            case let n as NSNumber:
                // Column affinity fixes any int/real mismatch on store, so the
                // only thing that matters is preserving fractional values.
                if CFNumberIsFloatType(n) {
                    sqlite3_bind_double(stmt, i, n.doubleValue)
                } else {
                    sqlite3_bind_int64(stmt, i, n.int64Value)
                }
            default:
                sqlite3_bind_null(stmt, i)
            }
        }
        return nil
    }

    /// Read one column; real BLOBs are base64-tagged so JS rebuilds the bytes.
    private func columnValue(_ stmt: OpaquePointer?, _ i: Int32) -> Any {
        switch sqlite3_column_type(stmt, i) {
        case SQLITE_INTEGER:
            return sqlite3_column_int64(stmt, i)
        case SQLITE_FLOAT:
            return sqlite3_column_double(stmt, i)
        case SQLITE_BLOB:
            let count = Int(sqlite3_column_bytes(stmt, i))
            let data = sqlite3_column_blob(stmt, i).map { Data(bytes: $0, count: count) } ?? Data()
            return Self.blobPrefix + data.base64EncodedString()
        case SQLITE_NULL:
            return NSNull()
        default:
            return String(cString: sqlite3_column_text(stmt, i))
        }
    }
}
