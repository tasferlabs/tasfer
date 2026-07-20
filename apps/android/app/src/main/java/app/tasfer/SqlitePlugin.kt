package app.tasfer

import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteStatement
import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

/**
 * System-SQLite database plugin — replaces @capacitor-community/sqlite.
 *
 * Uses Android's built-in android.database.sqlite (plain SQLite, no bundled
 * cryptography), so the app ships no encryption code and is not subject to the
 * SQLCipher export-compliance obligation. The database is a plain unencrypted
 * file under the app's private data dir (allowBackup="false" keeps it on-device).
 *
 * Mirrors the iOS SqliteBridgePlugin wire shape so adapters/capacitor.ts is a
 * single code path: `{ values }` for query, `{ changes: { changes, lastId } }`
 * for run. Bytes cross the JSON bridge as base64 tagged with [blobPrefix].
 */
@CapacitorPlugin(name = "TasferSqlite")
class SqlitePlugin : Plugin() {
    /** Uint8Array params/results are base64 with this prefix on the JSON bridge. */
    private val blobPrefix = "__blob__:"
    private var db: SQLiteDatabase? = null
    private val lock = Any()

    @PluginMethod
    fun open(call: PluginCall) {
        try {
            synchronized(lock) {
                if (db == null) {
                    val name = call.getString("database") ?: "tasfer"
                    val file = context.getDatabasePath("$name.db")
                    file.parentFile?.mkdirs()
                    val handle = SQLiteDatabase.openOrCreateDatabase(file, null)
                    handle.execSQL("PRAGMA journal_mode=WAL;")
                    handle.execSQL("PRAGMA foreign_keys=ON;")
                    db = handle
                }
            }
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message, e)
        }
    }

    @PluginMethod
    fun query(call: PluginCall) {
        val sql = call.getString("statement") ?: ""
        val values = call.getArray("values") ?: JSArray()
        try {
            synchronized(lock) {
                val handle = db ?: throw IllegalStateException("Database not open")
                // SELECTs never bind BLOBs in this app; string args are enough,
                // since numeric columns coerce a text param at comparison time.
                val args = arrayOfNulls<String>(values.length())
                for (i in 0 until values.length()) {
                    val v = values.get(i)
                    args[i] = if (v == JSONObject.NULL) null else v.toString()
                }
                val rows = JSArray()
                handle.rawQuery(sql, args).use { cursor ->
                    while (cursor.moveToNext()) {
                        val row = JSObject()
                        for (c in 0 until cursor.columnCount) {
                            val key = cursor.getColumnName(c)
                            when (cursor.getType(c)) {
                                Cursor.FIELD_TYPE_NULL -> row.put(key, JSONObject.NULL)
                                Cursor.FIELD_TYPE_INTEGER -> row.put(key, cursor.getLong(c))
                                Cursor.FIELD_TYPE_FLOAT -> row.put(key, cursor.getDouble(c))
                                Cursor.FIELD_TYPE_BLOB ->
                                    row.put(key, blobPrefix + Base64.encodeToString(cursor.getBlob(c), Base64.NO_WRAP))
                                else -> row.put(key, cursor.getString(c))
                            }
                        }
                        rows.put(row)
                    }
                }
                call.resolve(JSObject().put("values", rows))
            }
        } catch (e: Exception) {
            call.reject(e.message, e)
        }
    }

    @PluginMethod
    fun run(call: PluginCall) {
        val sql = call.getString("statement") ?: ""
        val values = call.getArray("values") ?: JSArray()
        try {
            synchronized(lock) {
                val handle = db ?: throw IllegalStateException("Database not open")
                val stmt = handle.compileStatement(sql)
                try {
                    bind(stmt, values)
                    val head = sql.trimStart()
                    val insert = head.regionMatches(0, "INSERT", 0, 6, ignoreCase = true) ||
                        head.regionMatches(0, "REPLACE", 0, 7, ignoreCase = true)
                    val changes = JSObject()
                    if (insert) {
                        val rowId = stmt.executeInsert() // -1 when OR IGNORE skipped the row
                        changes.put("changes", if (rowId >= 0) 1 else 0)
                        changes.put("lastId", rowId)
                    } else {
                        changes.put("changes", stmt.executeUpdateDelete())
                        changes.put("lastId", 0)
                    }
                    call.resolve(JSObject().put("changes", changes))
                } finally {
                    stmt.close()
                }
            }
        } catch (e: Exception) {
            call.reject(e.message, e)
        }
    }

    @PluginMethod
    fun exec(call: PluginCall) {
        val sql = call.getString("statements") ?: ""
        try {
            synchronized(lock) {
                val handle = db ?: throw IllegalStateException("Database not open")
                // execSQL runs a single statement, so split the schema DDL block.
                for (part in sql.split(";")) {
                    val s = part.trim()
                    if (s.isNotEmpty()) handle.execSQL(s)
                }
            }
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message, e)
        }
    }

    @PluginMethod fun beginTransaction(call: PluginCall) = execRaw("BEGIN", call)
    @PluginMethod fun commitTransaction(call: PluginCall) = execRaw("COMMIT", call)
    @PluginMethod fun rollbackTransaction(call: PluginCall) = execRaw("ROLLBACK", call)

    private fun execRaw(sql: String, call: PluginCall) {
        try {
            synchronized(lock) {
                (db ?: throw IllegalStateException("Database not open")).execSQL(sql)
            }
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message, e)
        }
    }

    private fun bind(stmt: SQLiteStatement, values: JSArray) {
        for (i in 0 until values.length()) {
            val idx = i + 1
            when (val v = values.get(i)) {
                JSONObject.NULL -> stmt.bindNull(idx)
                is Int -> stmt.bindLong(idx, v.toLong())
                is Long -> stmt.bindLong(idx, v)
                is Double -> stmt.bindDouble(idx, v)
                is Float -> stmt.bindDouble(idx, v.toDouble())
                is Boolean -> stmt.bindLong(idx, if (v) 1L else 0L)
                is String ->
                    if (v.startsWith(blobPrefix))
                        stmt.bindBlob(idx, Base64.decode(v.substring(blobPrefix.length), Base64.NO_WRAP))
                    else stmt.bindString(idx, v)
                else -> stmt.bindString(idx, v.toString())
            }
        }
    }
}
