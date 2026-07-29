// WebSQL -> IndexedDB shim for Astea Mobile
// Intercepts window.openDatabase() and translates to IndexedDB
// v3: Added localStorage cache for synchronous reads, fixed ? param substitution
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

        m = sql.match(/^INSERT\s+INTO\s+([_a-zA-Z]\w*)\s*VALUES\s*\(([^)]+)\)/i);
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

    // Parse WHERE clause, substituting ? placeholders with params
    // paramOffset: index into params where WHERE-clause params start
    function parseWhere(where, params, paramOffset) {
        if (!where) return { conds: null, paramCount: 0 };
        const conds = [];
        const parts = where.split(/\s+AND\s+/i);
        let pIdx = paramOffset;
        for (const p of parts) {
            const m = p.match(/([_a-zA-Z]\w*)\s*=\s*(.+)/);
            if (m) {
                let value = m[2].trim().replace(/['"]/g, '');
                if (value === '?') {
                    value = params[pIdx++];
                }
                conds.push({ column: m[1].trim(), value });
            }
        }
        return { conds, paramCount: pIdx - paramOffset };
    }

    // ── localStorage Cache ──────────────────────────────────
    // Pre-loads table data from localStorage so SELECT can be served
    // synchronously, eliminating the async timing gap that caused
    // mobileoptions_store to be empty when initSecurity checked it.
    class TableCache {
        constructor(dbName) {
            this.lsPrefix = '__pcf_' + dbName + '_';
            this.tableListKey = '__pcf_' + dbName + '_tables';
            this.data = {};
            this._load();
        }

        _load() {
            try {
                const tables = JSON.parse(localStorage.getItem(this.tableListKey) || '[]');
                for (const t of tables) {
                    const raw = localStorage.getItem(this.lsPrefix + t);
                    if (raw) this.data[t] = JSON.parse(raw);
                }
            } catch (e) { /* ignore */ }
        }

        _saveTable(name) {
            try {
                localStorage.setItem(this.lsPrefix + name,
                    JSON.stringify(this.data[name] || []));
                localStorage.setItem(this.tableListKey,
                    JSON.stringify(Object.keys(this.data)));
            } catch (e) { /* localStorage might be full */ }
        }

        hasTable(name) { return name in this.data; }
        getTable(name) { return this.data[name] || []; }

        createTable(name) {
            if (!(name in this.data)) {
                this.data[name] = [];
                this._saveTable(name);
            }
        }

        insert(table, row) {
            if (!this.data[table]) this.data[table] = [];
            const maxId = this.data[table].reduce(
                (mx, r) => Math.max(mx, r.id || 0), 0);
            row.id = maxId + 1;
            this.data[table].push(row);
            this._saveTable(table);
            return row.id;
        }

        update(table, conds, updates) {
            const rows = this.data[table] || [];
            let affected = 0;
            for (const row of rows) {
                if (conds && !conds.every(c =>
                    String(row[c.column]) === String(c.value))) continue;
                Object.assign(row, updates);
                affected++;
            }
            if (affected > 0) this._saveTable(table);
            return affected;
        }

        deleteRows(table, conds) {
            if (!this.data[table]) return 0;
            if (!conds) {
                const count = this.data[table].length;
                this.data[table] = [];
                this._saveTable(table);
                return count;
            }
            const before = this.data[table].length;
            this.data[table] = this.data[table].filter(row =>
                !conds.every(c => String(row[c.column]) === String(c.value)));
            const affected = before - this.data[table].length;
            if (affected > 0) this._saveTable(table);
            return affected;
        }

        dropTable(table) {
            delete this.data[table];
            try {
                localStorage.removeItem(this.lsPrefix + table);
                localStorage.setItem(this.tableListKey,
                    JSON.stringify(Object.keys(this.data)));
            } catch (e) { /* ignore */ }
        }

        selectMaster(name) {
            if (name) {
                return (name in this.data) ? [{ name }] : [];
            }
            return Object.keys(this.data)
                .filter(n => n !== '_schema')
                .map(n => ({ name: n }));
        }
    }

    // ── IndexedDB Wrapper ───────────────────────────────────
    class IDBWrapper {
        constructor(dbName, cache) {
            this.dbName = dbName;
            this.cache = cache;
            this.idb = null;
            this._ready = null;
            this._upgrading = false;
            this._writeQueue = [];
            this._flushing = false;
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
                        // Wait up to 2s for other connections to close
                        setTimeout(() => reject(new Error('Blocked')), 2000);
                    };
                });
            } catch (e) {
                if (e.message === 'Blocked') {
                    await new Promise(r => setTimeout(r, 500));
                    this._upgrading = false;
                    // Reconnect and retry
                    await this.ready();
                    if (this.idb.objectStoreNames.contains(name)) return;
                    return this.ensureStore(name);
                }
                this._upgrading = false;
                throw e;
            }
            this._upgrading = false;
        }

        // ── Synchronous execution (from cache) ──

        canExecuteSync(parsed) {
            switch (parsed.type) {
                case 'CREATE_TABLE':
                case 'INSERT':
                case 'INSERT_RAW':
                case 'UPDATE':
                case 'DELETE':
                case 'DROP_TABLE':
                case 'SELECT_MASTER':
                    return true;
                case 'SELECT':
                    // Only if the table is cached
                    return this.cache.hasTable(parsed.table);
                default:
                    return false;
            }
        }

        executeSync(parsed, params) {
            switch (parsed.type) {
                case 'CREATE_TABLE':
                    this.cache.createTable(parsed.table);
                    this._scheduleAsyncWrite(parsed, params);
                    return { rowsAffected: 0 };

                case 'INSERT': {
                    const row = {};
                    for (let i = 0; i < parsed.columns.length; i++) {
                        row[parsed.columns[i]] = parsed.values[i] === '?'
                            ? params[i]
                            : parsed.values[i].replace(/^['"]|['"]$/g, '');
                    }
                    const insertId = this.cache.insert(parsed.table, row);
                    this._scheduleAsyncWrite(parsed, params);
                    return { rowsAffected: 1, insertId };
                }

                case 'INSERT_RAW': {
                    const vals = parsed.rawValues.split(',')
                        .map(v => v.trim().replace(/^['"]|['"]$/g, ''));
                    this.cache.insert(parsed.table, { _values: vals });
                    this._scheduleAsyncWrite(parsed, params);
                    return { rowsAffected: 1 };
                }

                case 'SELECT': {
                    let rows = this.cache.getTable(parsed.table);
                    if (parsed.where) {
                        const { conds } = parseWhere(parsed.where, params, 0);
                        if (conds) {
                            rows = rows.filter(row => conds.every(c =>
                                String(row[c.column]) === String(c.value)));
                        }
                    }
                    // Return shallow copies so callers can't mutate cache
                    return { rows: rows.map(r => Object.assign({}, r)) };
                }

                case 'UPDATE': {
                    // Parse SET clause — track how many params it consumes
                    const updates = {};
                    let setParamIdx = 0;
                    for (const set of parsed.sets) {
                        if (set.value === '?') {
                            updates[set.column] = params[setParamIdx++];
                        } else {
                            updates[set.column] =
                                set.value.replace(/^['"]|['"]$/g, '');
                        }
                    }
                    const { conds } = parseWhere(
                        parsed.where, params, setParamIdx);
                    const affected = this.cache.update(
                        parsed.table, conds, updates);
                    this._scheduleAsyncWrite(parsed, params);
                    return { rowsAffected: affected };
                }

                case 'DELETE': {
                    const { conds } = parseWhere(parsed.where, params, 0);
                    const affected = this.cache.deleteRows(
                        parsed.table, conds);
                    this._scheduleAsyncWrite(parsed, params);
                    return { rowsAffected: affected };
                }

                case 'DROP_TABLE': {
                    this.cache.dropTable(parsed.table);
                    this._scheduleAsyncWrite(parsed, params);
                    return { rowsAffected: 0 };
                }

                case 'SELECT_MASTER':
                    return { rows: this.cache.selectMaster(parsed.name) };

                default:
                    return null;
            }
        }

        // ── Async write (flush cache changes to IndexedDB) ──

        _scheduleAsyncWrite(parsed, params) {
            this._writeQueue.push({ parsed, params });
            if (!this._flushing) {
                this._flushing = true;
                setTimeout(() => this._flushWrites(), 0);
            }
        }

        async _flushWrites() {
            const queue = this._writeQueue;
            this._writeQueue = [];
            this._flushing = false;
            for (const { parsed, params } of queue) {
                try {
                    await this._writeToIDB(parsed, params);
                } catch (e) {
                    console.error('[polyfill] async write failed:', e);
                }
            }
        }

        async _writeToIDB(parsed, params) {
            await this.ready();
            switch (parsed.type) {
                case 'CREATE_TABLE': {
                    await this.ensureStore(parsed.table);
                    const tx = this.idb.transaction('_schema', 'readwrite');
                    tx.objectStore('_schema')
                        .put({ name: parsed.table, type: 'table' });
                    await new Promise(r =>
                        { tx.oncomplete = r; tx.onerror = r; });
                    break;
                }
                case 'INSERT': {
                    await this.ensureStore(parsed.table);
                    const row = {};
                    for (let i = 0; i < parsed.columns.length; i++) {
                        row[parsed.columns[i]] = parsed.values[i] === '?'
                            ? params[i]
                            : parsed.values[i].replace(/^['"]|['"]$/g, '');
                    }
                    const tx = this.idb.transaction(
                        parsed.table, 'readwrite');
                    tx.objectStore(parsed.table).add(row);
                    await new Promise(r =>
                        { tx.oncomplete = r; tx.onerror = r; });
                    break;
                }
                case 'INSERT_RAW': {
                    await this.ensureStore(parsed.table);
                    const vals = parsed.rawValues.split(',')
                        .map(v => v.trim().replace(/^['"]|['"]$/g, ''));
                    const tx = this.idb.transaction(
                        parsed.table, 'readwrite');
                    tx.objectStore(parsed.table).add({ _values: vals });
                    await new Promise(r =>
                        { tx.oncomplete = r; tx.onerror = r; });
                    break;
                }
                case 'UPDATE': {
                    if (!this.idb.objectStoreNames.contains(parsed.table))
                        break;
                    const updates = {};
                    let setParamIdx = 0;
                    for (const set of parsed.sets) {
                        if (set.value === '?') {
                            updates[set.column] = params[setParamIdx++];
                        } else {
                            updates[set.column] =
                                set.value.replace(/^['"]|['"]$/g, '');
                        }
                    }
                    const { conds } = parseWhere(
                        parsed.where, params, setParamIdx);
                    const tx = this.idb.transaction(
                        parsed.table, 'readwrite');
                    const store = tx.objectStore(parsed.table);
                    const all = await new Promise(resolve => {
                        const req = store.getAll();
                        req.onsuccess = () => resolve(req.result);
                        req.onerror = () => resolve([]);
                    });
                    for (const row of all) {
                        if (conds && !conds.every(c =>
                            String(row[c.column]) === String(c.value)))
                            continue;
                        Object.assign(row, updates);
                        store.put(row);
                    }
                    await new Promise(r =>
                        { tx.oncomplete = r; tx.onerror = r; });
                    break;
                }
                case 'DELETE': {
                    if (!this.idb.objectStoreNames.contains(parsed.table))
                        break;
                    const { conds } = parseWhere(parsed.where, params, 0);
                    const tx = this.idb.transaction(
                        parsed.table, 'readwrite');
                    const store = tx.objectStore(parsed.table);
                    const all = await new Promise(resolve => {
                        const req = store.getAll();
                        req.onsuccess = () => resolve(req.result);
                        req.onerror = () => resolve([]);
                    });
                    if (!conds) {
                        for (const row of all) store.delete(row.id);
                    } else {
                        for (const row of all) {
                            if (conds.every(c =>
                                String(row[c.column]) === String(c.value)))
                                store.delete(row.id);
                        }
                    }
                    await new Promise(r =>
                        { tx.oncomplete = r; tx.onerror = r; });
                    break;
                }
                case 'DROP_TABLE': {
                    await this.deleteStore(parsed.table);
                    await this.ready();
                    const tx = this.idb.transaction('_schema', 'readwrite');
                    tx.objectStore('_schema').delete(parsed.table);
                    await new Promise(r => { tx.oncomplete = r; });
                    break;
                }
            }
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
            try {
                await new Promise((resolve, reject) => {
                    const req = indexedDB.open(
                        this.dbName, currentVersion + 1);
                    req.onupgradeneeded = () => {
                        req.result.deleteObjectStore(name);
                    };
                    req.onsuccess = () => {
                        this.idb = req.result;
                        resolve();
                    };
                    req.onerror = () => reject(req.error);
                    req.onblocked = () => {
                        setTimeout(() => reject(new Error('Blocked')), 2000);
                    };
                });
            } catch (e) {
                if (e.message === 'Blocked') {
                    await new Promise(r => setTimeout(r, 500));
                    this._upgrading = false;
                    await this.ready();
                    return;
                }
                throw e;
            }
            this._upgrading = false;
        }

        // ── Async execution (cache miss fallback) ──
        // Used when the table is not in the cache (first load).
        // Reads from IndexedDB and populates the cache.

        async execute(parsed, params) {
            await this.ready();

            switch (parsed.type) {
                case 'CREATE_TABLE': {
                    await this.ensureStore(parsed.table);
                    const tx = this.idb.transaction('_schema', 'readwrite');
                    tx.objectStore('_schema')
                        .put({ name: parsed.table, type: 'table' });
                    await new Promise(r =>
                        { tx.oncomplete = r; tx.onerror = r; });
                    this.cache.createTable(parsed.table);
                    return { rowsAffected: 0 };
                }

                case 'INSERT': {
                    await this.ensureStore(parsed.table);
                    const row = {};
                    for (let i = 0; i < parsed.columns.length; i++) {
                        row[parsed.columns[i]] = parsed.values[i] === '?'
                            ? params[i]
                            : parsed.values[i].replace(/^['"]|['"]$/g, '');
                    }
                    const tx = this.idb.transaction(
                        parsed.table, 'readwrite');
                    const store = tx.objectStore(parsed.table);
                    let insertId = 0;
                    store.add(row).onsuccess = (e) => {
                        insertId = e.target.result;
                    };
                    await new Promise(r =>
                        { tx.oncomplete = r; tx.onerror = r; });
                    this.cache.insert(parsed.table, row);
                    return { rowsAffected: 1, insertId };
                }

                case 'INSERT_RAW': {
                    await this.ensureStore(parsed.table);
                    const vals = parsed.rawValues.split(',')
                        .map(v => v.trim().replace(/^['"]|['"]$/g, ''));
                    const tx = this.idb.transaction(
                        parsed.table, 'readwrite');
                    tx.objectStore(parsed.table).add({ _values: vals });
                    await new Promise(r =>
                        { tx.oncomplete = r; tx.onerror = r; });
                    return { rowsAffected: 1 };
                }

                case 'SELECT': {
                    if (!this.idb.objectStoreNames.contains(parsed.table)) {
                        this.cache.createTable(parsed.table);
                        return { rows: [] };
                    }
                    const tx = this.idb.transaction(
                        parsed.table, 'readonly');
                    const store = tx.objectStore(parsed.table);
                    const all = await new Promise(resolve => {
                        const req = store.getAll();
                        req.onsuccess = () => resolve(req.result);
                        req.onerror = () => resolve([]);
                    });
                    // Populate cache for future synchronous reads
                    this.cache.data[parsed.table] = all;
                    this.cache._saveTable(parsed.table);

                    let rows = all;
                    if (parsed.where) {
                        const { conds } = parseWhere(
                            parsed.where, params, 0);
                        if (conds) {
                            rows = rows.filter(row => conds.every(c =>
                                String(row[c.column]) === String(c.value)));
                        }
                    }
                    return { rows: rows.map(r => Object.assign({}, r)) };
                }

                case 'UPDATE': {
                    if (!this.idb.objectStoreNames.contains(parsed.table)) {
                        return { rowsAffected: 0 };
                    }
                    const updates = {};
                    let setParamIdx = 0;
                    for (const set of parsed.sets) {
                        if (set.value === '?') {
                            updates[set.column] = params[setParamIdx++];
                        } else {
                            updates[set.column] =
                                set.value.replace(/^['"]|['"]$/g, '');
                        }
                    }
                    const { conds } = parseWhere(
                        parsed.where, params, setParamIdx);
                    const tx = this.idb.transaction(
                        parsed.table, 'readwrite');
                    const store = tx.objectStore(parsed.table);
                    const all = await new Promise(resolve => {
                        store.getAll().onsuccess = (e) =>
                            resolve(e.target.result);
                    });
                    let affected = 0;
                    for (const row of all) {
                        if (conds && !conds.every(c =>
                            String(row[c.column]) === String(c.value)))
                            continue;
                        Object.assign(row, updates);
                        store.put(row);
                        affected++;
                    }
                    await new Promise(r =>
                        { tx.oncomplete = r; tx.onerror = r; });
                    this.cache.update(parsed.table, conds, updates);
                    return { rowsAffected: affected };
                }

                case 'DELETE': {
                    if (!this.idb.objectStoreNames.contains(parsed.table))
                        return { rowsAffected: 0 };
                    const { conds } = parseWhere(parsed.where, params, 0);
                    const tx = this.idb.transaction(
                        parsed.table, 'readwrite');
                    const store = tx.objectStore(parsed.table);
                    const all = await new Promise(resolve => {
                        store.getAll().onsuccess = (e) =>
                            resolve(e.target.result);
                    });
                    let affected = 0;
                    if (!conds) {
                        for (const row of all) store.delete(row.id);
                        affected = all.length;
                    } else {
                        for (const row of all) {
                            if (conds.every(c =>
                                String(row[c.column]) === String(c.value))) {
                                store.delete(row.id);
                                affected++;
                            }
                        }
                    }
                    await new Promise(r =>
                        { tx.oncomplete = r; tx.onerror = r; });
                    this.cache.deleteRows(parsed.table, conds);
                    return { rowsAffected: affected };
                }

                case 'DROP_TABLE': {
                    await this.deleteStore(parsed.table);
                    await this.ready();
                    const tx = this.idb.transaction('_schema', 'readwrite');
                    tx.objectStore('_schema').delete(parsed.table);
                    await new Promise(r => { tx.oncomplete = r; });
                    this.cache.dropTable(parsed.table);
                    return { rowsAffected: 0 };
                }

                case 'SELECT_MASTER': {
                    if (parsed.name) {
                        return { rows: this.idb.objectStoreNames
                            .contains(parsed.name)
                                ? [{ name: parsed.name }] : [] };
                    }
                    return { rows: Array.from(this.idb.objectStoreNames)
                        .filter(n => n !== '_schema')
                        .map(n => ({ name: n })) };
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
            this.cache = new TableCache(name);
            this.idb = new IDBWrapper(name, this.cache);
        }

        transaction(fn, errorFn, successFn) {
            const tx = new WebSQLTransaction(this);
            fn(tx);

            // Try synchronous execution from cache first.
            // This eliminates the async timing gap that caused
            // mobileoptions_store to be empty when checked.
            if (tx._trySync()) {
                if (typeof successFn === 'function') successFn();
                return;
            }

            // Fall back to async IndexedDB execution
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

        // Attempt to execute all queued statements synchronously
        // from the in-memory cache. Returns true if successful,
        // false if async execution is needed.
        _trySync() {
            // First pass: verify all statements can be served from cache
            const parsed = [];
            for (const item of this.queue) {
                const p = parseSQL(item.sql);
                if (!this.db.idb.canExecuteSync(p)) return false;
                parsed.push({ item, p });
            }

            // Second pass: execute all synchronously
            for (const { item, p } of parsed) {
                try {
                    const result = this.db.idb.executeSync(p, item.params);
                    if (result === null) return false;
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
                    console.error('[polyfill] sync error:', item.sql, err);
                    if (typeof item.errorFn === 'function')
                        item.errorFn(this, err);
                    return true; // Handled (with error)
                }
            }
            return true;
        }

        async _exec() {
            for (const item of this.queue) {
                try {
                    const parsed = parseSQL(item.sql);
                    const result = await this.db.idb.execute(
                        parsed, item.params);
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
                    console.error('[polyfill] executeSql error:',
                        item.sql, err);
                    if (typeof item.errorFn === 'function')
                        item.errorFn(this, err);
                }
            }
        }
    }

    // ── Intercept ────────────────────────────────────────────
    window.openDatabase = function(name, version, displayName, estimatedSize) {
        return new WebSQLDatabase(name);
    };

    console.log('[polyfill] WebSQL -> IndexedDB shim loaded (v3)');
})();
