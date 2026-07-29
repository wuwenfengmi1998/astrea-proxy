// WebSQL → IndexedDB shim for Astea Mobile
// Intercepts window.openDatabase() and translates to IndexedDB
(function() {
    'use strict';

    // ── SQL Parser ──────────────────────────────────────────
    function parseSQL(sql) {
        sql = sql.trim();
        const upper = sql.toUpperCase();

        let m = upper.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([_a-zA-Z]\w*)/i);
        if (m) return { type: 'CREATE_TABLE', table: m[1] };

        m = sql.match(/^INSERT\s+INTO\s+([_a-zA-Z]\w*)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
        if (m) {
            return { type: 'INSERT', table: m[1],
                columns: m[2].split(',').map(c => c.trim()),
                values: m[3].split(',').map(v => v.trim()) };
        }

        m = sql.match(/^INSERT\s+INTO\s+([_a-zA-Z]\w*)\s+VALUES\s*\(([^)]+)\)/i);
        if (m) return { type: 'INSERT_RAW', table: m[1], rawValues: m[2] };

        m = sql.match(/^UPDATE\s+([_a-zA-Z]\w*)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/i);
        if (m) {
            const sets = m[2].split(',').map(s => {
                const p = s.trim().split('=');
                return { column: p[0].trim(), value: (p[1]||'?').trim() };
            });
            return { type: 'UPDATE', table: m[1], sets: sets, where: m[3] || null };
        }

        m = sql.match(/^DELETE\s+FROM\s+([_a-zA-Z]\w*)(?:\s+WHERE\s+(.+))?$/i);
        if (m) return { type: 'DELETE', table: m[1], where: m[2] || null };

        m = sql.match(/^DROP\s+TABLE\s+([_a-zA-Z]\w*)/i);
        if (m) return { type: 'DROP_TABLE', table: m[1] };

        if (upper.includes('SQLITE_MASTER')) {
            const nm = sql.match(/name\s*=\s*['"]([^'"]+)['"]/i);
            return { type: 'SELECT_MASTER', name: nm ? nm[1] : null };
        }

        m = sql.match(/^SELECT\s+(.+?)\s+FROM\s+([_a-zA-Z]\w*)(?:\s+WHERE\s+(.+))?$/i);
        if (m) return { type: 'SELECT', columns: m[1], table: m[2], where: m[3] || null };

        return { type: 'UNKNOWN', sql: sql };
    }

    function parseWhere(where) {
        if (!where) return null;
        const conds = [];
        const parts = where.split(/\s+AND\s+/i);
        for (const p of parts) {
            const m = p.match(/([_a-zA-Z]\w*)\s*=\s*(.+)/);
            if (m) conds.push({ column: m[1].trim(), value: m[2].trim().replace(/['"]/g, '') });
        }
        return conds;
    }

    // ── IndexedDB Wrapper ───────────────────────────────────
    class IDBWrapper {
        constructor(dbName) {
            this.dbName = dbName;
            this.idb = null;
            this._ready = null;
            this._upgrading = false;
        }

        ready() {
            if (this._ready) return this._ready;
            this._ready = new Promise((resolve, reject) => {
                const req = indexedDB.open(this.dbName);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains('_schema')) {
                        db.createObjectStore('_schema', { keyPath: 'name' });
                    }
                };
                req.onsuccess = () => {
                    this.idb = req.result;
                    resolve(this);
                };
                req.onerror = () => {
                    this._ready = null;
                    reject(req.error);
                };
            });
            return this._ready;
        }

        async ensureStore(name) {
            await this.ready();
            if (this.idb.objectStoreNames.contains(name)) return;

            // Wait for any in-flight upgrade
            while (this._upgrading) {
                await new Promise(r => setTimeout(r, 50));
            }
            // Double-check after waiting
            if (this.idb.objectStoreNames.contains(name)) return;

            this._upgrading = true;
            const currentVersion = this.idb.version;
            this.idb.close();

            try {
                await new Promise((resolve, reject) => {
                    const req = indexedDB.open(this.dbName, currentVersion + 1);
                    req.onupgradeneeded = () => {
                        if (!req.result.objectStoreNames.contains(name)) {
                            req.result.createObjectStore(name,
                                { keyPath: 'id', autoIncrement: true });
                        }
                    };
                    req.onsuccess = () => {
                        this.idb = req.result;
                        resolve();
                    };
                    req.onerror = () => reject(req.error);
                    req.onblocked = () => {
                        // Old connection blocking — try closing and retry
                        req.close();
                        reject(new Error('Blocked'));
                    };
                });
            } catch (e) {
                // Retry once after blocked
                if (e.message === 'Blocked') {
                    await new Promise(r => setTimeout(r, 300));
                    await this.ready(); // Reconnect
                    if (this.idb.objectStoreNames.contains(name)) {
                        this._upgrading = false;
                        return;
                    }
                    // Retry upgrade
                    await this.ensureStore(name);
                } else {
                    throw e;
                }
            }
            this._upgrading = false;
        }

        async deleteStore(name) {
            await this.ready();
            if (!this.idb.objectStoreNames.contains(name)) return;

            while (this._upgrading) {
                await new Promise(r => setTimeout(r, 50));
            }
            this._upgrading = true;
            const currentVersion = this.idb.version;
            this.idb.close();

            await new Promise((resolve, reject) => {
                const req = indexedDB.open(this.dbName, currentVersion + 1);
                req.onupgradeneeded = () => { req.result.deleteObjectStore(name); };
                req.onsuccess = () => { this.idb = req.result; resolve(); };
                req.onerror = () => reject(req.error);
            });
            this._upgrading = false;
        }

        async execute(parsed, params) {
            await this.ready();

            switch (parsed.type) {
                case 'CREATE_TABLE': {
                    await this.ensureStore(parsed.table);
                    const tx = this.idb.transaction('_schema', 'readwrite');
                    tx.objectStore('_schema').put({ name: parsed.table, type: 'table' });
                    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
                    return { rowsAffected: 0 };
                }

                case 'INSERT': {
                    await this.ensureStore(parsed.table);
                    const row = {};
                    for (let i = 0; i < parsed.columns.length; i++) {
                        row[parsed.columns[i]] = parsed.values[i] === '?'
                            ? params[i] : parsed.values[i].replace(/^['"]|['"]$/g, '');
                    }
                    const tx = this.idb.transaction(parsed.table, 'readwrite');
                    const store = tx.objectStore(parsed.table);
                    let insertId = 0;
                    store.add(row).onsuccess = (e) => { insertId = e.target.result; };
                    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
                    return { rowsAffected: 1, insertId };
                }

                case 'INSERT_RAW': {
                    await this.ensureStore(parsed.table);
                    const vals = parsed.rawValues.split(',').map(v => v.trim().replace(/^['"]|['"]$/g, ''));
                    const tx = this.idb.transaction(parsed.table, 'readwrite');
                    const store = tx.objectStore(parsed.table);
                    store.add({ _values: vals });
                    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
                    return { rowsAffected: 1 };
                }

                case 'SELECT': {
                    if (!this.idb.objectStoreNames.contains(parsed.table)) {
                        return { rows: [] };
                    }
                    const tx = this.idb.transaction(parsed.table, 'readonly');
                    const store = tx.objectStore(parsed.table);
                    const all = await new Promise(resolve => {
                        const req = store.getAll();
                        req.onsuccess = () => resolve(req.result);
                        req.onerror = () => resolve([]);
                    });
                    let rows = all;
                    if (parsed.where) {
                        const conds = parseWhere(parsed.where);
                        if (conds) {
                            rows = rows.filter(row => conds.every(c =>
                                String(row[c.column]) === String(c.value)));
                        }
                    }
                    return { rows };
                }

                case 'UPDATE': {
                    if (!this.idb.objectStoreNames.contains(parsed.table)) {
                        return { rowsAffected: 0 };
                    }
                    const tx = this.idb.transaction(parsed.table, 'readwrite');
                    const store = tx.objectStore(parsed.table);
                    const all = await new Promise(resolve => {
                        store.getAll().onsuccess = (e) => resolve(e.target.result);
                    });
                    const conds = parseWhere(parsed.where);
                    let affected = 0;
                    for (const row of all) {
                        if (conds && !conds.every(c => String(row[c.column]) === String(c.value)))
                            continue;
                        for (const set of parsed.sets)
                            row[set.column] = params[parseInt(set.value.replace('?','')) || 0];
                        store.put(row);
                        affected++;
                    }
                    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
                    return { rowsAffected: affected };
                }

                case 'DELETE': {
                    if (!this.idb.objectStoreNames.contains(parsed.table))
                        return { rowsAffected: 0 };
                    const tx = this.idb.transaction(parsed.table, 'readwrite');
                    const store = tx.objectStore(parsed.table);
                    const all = await new Promise(resolve => {
                        store.getAll().onsuccess = (e) => resolve(e.target.result);
                    });
                    if (!parsed.where) {
                        for (const row of all) store.delete(row.id);
                        await new Promise(r => { tx.oncomplete = r; });
                        return { rowsAffected: all.length };
                    }
                    const conds = parseWhere(parsed.where);
                    let affected = 0;
                    for (const row of all) {
                        if (conds.every(c => String(row[c.column]) === String(c.value))) {
                            store.delete(row.id);
                            affected++;
                        }
                    }
                    await new Promise(r => { tx.oncomplete = r; });
                    return { rowsAffected: affected };
                }

                case 'DROP_TABLE': {
                    await this.deleteStore(parsed.table);
                    await this.ready();
                    const tx = this.idb.transaction('_schema', 'readwrite');
                    tx.objectStore('_schema').delete(parsed.table);
                    await new Promise(r => { tx.oncomplete = r; });
                    return { rowsAffected: 0 };
                }

                case 'SELECT_MASTER': {
                    if (parsed.name) {
                        return { rows: this.idb.objectStoreNames.contains(parsed.name)
                            ? [{ name: parsed.name }] : [] };
                    }
                    return { rows: Array.from(this.idb.objectStoreNames)
                        .filter(n => n !== '_schema').map(n => ({ name: n })) };
                }

                default:
                    console.warn('[polyfill] Unhandled SQL:', parsed.sql);
                    return { rowsAffected: 0 };
            }
        }
    }

    // ── Database / Transaction Shim ──────────────────────────
    class WebSQLDatabase {
        constructor(name) {
            this.idb = new IDBWrapper(name);
        }
        transaction(fn, errorFn, successFn) {
            const tx = new WebSQLTransaction(this);
            fn(tx);
            tx._exec().then(() => {
                if (typeof successFn === 'function') successFn();
            }).catch(err => {
                console.error('[polyfill] TX error:', err);
                if (typeof errorFn === 'function') errorFn(err);
            });
        }
        readTransaction(fn, errorFn, successFn) {
            this.transaction(fn, errorFn, successFn);
        }
    }

    class WebSQLTransaction {
        constructor(db) {
            this.db = db;
            this.queue = [];
        }
        executeSql(sql, params, successFn, errorFn) {
            this.queue.push({ sql, params: params || [], successFn, errorFn });
        }
        async _exec() {
            for (const item of this.queue) {
                try {
                    const parsed = parseSQL(item.sql);
                    const result = await this.db.idb.execute(parsed, item.params);
                    const wrapped = {
                        insertId: result.insertId || 0,
                        rowsAffected: result.rowsAffected || 0,
                        rows: {
                            _data: result.rows || [],
                            get length() { return this._data.length; },
                            item: function(i) { return this._data[i]; }
                        }
                    };
                    if (typeof item.successFn === 'function')
                        item.successFn(this, wrapped);
                } catch (err) {
                    console.error('[polyfill] executeSql error:', item.sql, err);
                    if (typeof item.errorFn === 'function')
                        item.errorFn(this, err);
                }
            }
        }
    }

    // ── Intercept ────────────────────────────────────────────
    window.openDatabase = function(name, version, displayName, estimatedSize) {
        console.log('[polyfill] openDatabase:', name, version, displayName);
        return new WebSQLDatabase(name);
    };

    console.log('[polyfill] WebSQL → IndexedDB shim loaded (v2)');
})();