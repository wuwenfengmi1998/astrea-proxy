// WebSQL -> IndexedDB shim for Astea Mobile
// Intercepts window.openDatabase() and translates to IndexedDB
// v4: Async-only with localStorage cache for fast reads,
//     fixed ? params, ORDER BY/LIMIT support, case-insensitive store lookup
(function() {
    'use strict';

    // ── SQL Parser ──────────────────────────────────────────
    function parseSQL(sql) {
        sql = sql.trim();

        // Extract LIMIT from the end (must be done before ORDER BY,
        // since "ORDER BY Key ASC LIMIT 1" ends with LIMIT, not ASC)
        let limit = null;
        let lm = sql.match(/\s+LIMIT\s+(\d+)$/i);
        if (lm) {
            limit = parseInt(lm[1]);
            sql = sql.substring(0, lm.index);
        }

        // Extract ORDER BY from the end
        let orderBy = null;
        let obm = sql.match(/\s+ORDER\s+BY\s+(\w+)\s*(ASC|DESC)?$/i);
        if (obm) {
            orderBy = { column: obm[1], dir: (obm[2] || 'ASC').toUpperCase() };
            sql = sql.substring(0, obm.index);
        }

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
        if (m) return { type: 'SELECT', columns: m[1], table: m[2],
            where: m[3] || null, orderBy, limit };

        return { type: 'UNKNOWN', sql: sql };
    }

    // Parse WHERE clause, substituting ? placeholders with params
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

    // Apply ORDER BY and LIMIT to a rows array
    function applyOrderByLimit(rows, parsed) {
        if (parsed.orderBy) {
            const col = parsed.orderBy.column;
            const dir = parsed.orderBy.dir;
            rows = rows.slice().sort((a, b) => {
                const av = a[col], bv = b[col];
                if (av == null && bv == null) return 0;
                if (av == null) return 1;
                if (bv == null) return -1;
                if (av < bv) return dir === 'DESC' ? 1 : -1;
                if (av > bv) return dir === 'DESC' ? -1 : 1;
                return 0;
            });
        }
        if (parsed.limit != null) {
            rows = rows.slice(0, parsed.limit);
        }
        return rows;
    }

    // ── localStorage Cache ──────────────────────────────────
    class TableCache {
        constructor(dbName) {
            this.lsPrefix = '__pcf_' + dbName + '_';
            this.tableListKey = '__pcf_' + dbName + '_tables';
            this.data = {};
            this._dirty = new Set();
            this._load();
        }

        _load() {
            try {
                const tables = JSON.parse(
                    localStorage.getItem(this.tableListKey) || '[]');
                for (const t of tables) {
                    const raw = localStorage.getItem(this.lsPrefix + t);
                    if (raw) this.data[t] = JSON.parse(raw);
                }
            } catch (e) { /* ignore */ }
        }

        _markDirty(name) {
            this._dirty.add(this._ciKey(name) || name);
        }

        flushDirty() {
            for (const name of this._dirty) {
                try {
                    localStorage.setItem(this.lsPrefix + name,
                        JSON.stringify(this.data[name] || []));
                } catch (e) { /* localStorage might be full */ }
            }
            try {
                localStorage.setItem(this.tableListKey,
                    JSON.stringify(Object.keys(this.data)));
            } catch (e) { /* localStorage might be full */ }
            this._dirty.clear();
        }

        // Case-insensitive table lookup
        _ciKey(name) {
            if (name in this.data) return name;
            const lower = name.toLowerCase();
            for (const key in this.data) {
                if (key.toLowerCase() === lower) return key;
            }
            return null;
        }

        hasTable(name) { return this._ciKey(name) !== null; }
        getTable(name) {
            const k = this._ciKey(name);
            return k ? this.data[k] : [];
        }

        createTable(name) {
            if (!this._ciKey(name)) {
                this.data[name] = [];
                this._markDirty(name);
            }
        }

        insert(table, row) {
            const k = this._ciKey(table) || table;
            if (!this.data[k]) this.data[k] = [];
            const maxId = this.data[k].reduce(
                (mx, r) => Math.max(mx, r.id || 0), 0);
            row.id = maxId + 1;
            this.data[k].push(row);
            this._markDirty(k);
            return row.id;
        }

        update(table, conds, updates) {
            const k = this._ciKey(table);
            if (!k) return 0;
            const rows = this.data[k];
            let affected = 0;
            for (const row of rows) {
                if (conds && !conds.every(c =>
                    String(row[c.column]) === String(c.value))) continue;
                Object.assign(row, updates);
                affected++;
            }
            if (affected > 0) this._markDirty(k);
            return affected;
        }

        deleteRows(table, conds) {
            const k = this._ciKey(table);
            if (!k) return 0;
            if (!conds) {
                const count = this.data[k].length;
                this.data[k] = [];
                this._markDirty(k);
                return count;
            }
            const before = this.data[k].length;
            this.data[k] = this.data[k].filter(row =>
                !conds.every(c => String(row[c.column]) === String(c.value)));
            const affected = before - this.data[k].length;
            if (affected > 0) this._markDirty(k);
            return affected;
        }

        dropTable(table) {
            const k = this._ciKey(table);
            if (k) {
                delete this.data[k];
                try {
                    localStorage.removeItem(this.lsPrefix + k);
                    localStorage.setItem(this.tableListKey,
                        JSON.stringify(Object.keys(this.data)));
                } catch (e) {}
            }
        }

        selectMaster(name) {
            if (name) {
                return this.hasTable(name) ? [{ name }] : [];
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

        // Case-insensitive store name lookup
        _findStore(name) {
            if (!this.idb) return null;
            const names = this.idb.objectStoreNames;
            if (names.contains(name)) return name;
            const lower = name.toLowerCase();
            for (let i = 0; i < names.length; i++) {
                const sn = names.item(i);
                if (sn.toLowerCase() === lower) return sn;
            }
            return null;
        }

        async ensureStores(names) {
            await this.ready();
            const needCreate = names.filter(n => !this._findStore(n));
            if (needCreate.length === 0) return;

            while (this._upgrading) {
                await new Promise(r => setTimeout(r, 50));
            }
            const stillNeed = needCreate.filter(n => !this._findStore(n));
            if (stillNeed.length === 0) return;

            this._upgrading = true;
            const currentVersion = this.idb.version;
            this.idb.close();

            try {
                await new Promise((resolve, reject) => {
                    const req = indexedDB.open(
                        this.dbName, currentVersion + 1);
                    req.onupgradeneeded = () => {
                        const db = req.result;
                        for (const name of stillNeed) {
                            if (!db.objectStoreNames.contains(name)) {
                                db.createObjectStore(name,
                                    { keyPath: 'id', autoIncrement: true });
                            }
                        }
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
                    const remaining = stillNeed.filter(
                        n => !this._findStore(n));
                    if (remaining.length > 0) {
                        return this.ensureStores(remaining);
                    }
                    return;
                }
                this._upgrading = false;
                throw e;
            }
            this._upgrading = false;
        }

        async ensureStore(name) {
            await this.ready();
            if (this._findStore(name)) return;

            while (this._upgrading) {
                await new Promise(r => setTimeout(r, 50));
            }
            if (this._findStore(name)) return;

            this._upgrading = true;
            const currentVersion = this.idb.version;
            this.idb.close();

            try {
                await new Promise((resolve, reject) => {
                    const req = indexedDB.open(
                        this.dbName, currentVersion + 1);
                    req.onupgradeneeded = () => {
                        const db = req.result;
                        if (!db.objectStoreNames.contains(name)) {
                            db.createObjectStore(name,
                                { keyPath: 'id', autoIncrement: true });
                        }
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
                    if (this._findStore(name)) return;
                    return this.ensureStore(name);
                }
                this._upgrading = false;
                throw e;
            }
            this._upgrading = false;
        }

        async deleteStore(name) {
            await this.ready();
            const actual = this._findStore(name);
            if (!actual) return;
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
                        const db = req.result;
                        if (db.objectStoreNames.contains(name)) {
                            db.deleteObjectStore(name);
                        }
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

        async execute(parsed, params) {
            switch (parsed.type) {
                case 'CREATE_TABLE': {
                    this.cache.createTable(parsed.table);
                    await this.ready();
                    await this.ensureStore(parsed.table);
                    try {
                        const tx = this.idb.transaction('_schema', 'readwrite');
                        tx.objectStore('_schema')
                            .put({ name: parsed.table, type: 'table' });
                        await new Promise(r =>
                            { tx.oncomplete = r; tx.onerror = r; tx.onabort = r; });
                    } catch (e) { /* non-critical */ }
                    return { rowsAffected: 0 };
                }

                case 'INSERT': {
                    const row = {};
                    for (let i = 0; i < parsed.columns.length; i++) {
                        row[parsed.columns[i]] = parsed.values[i] === '?'
                            ? params[i]
                            : parsed.values[i].replace(/^['"]|['"]$/g, '');
                    }
                    const insertId = this.cache.insert(parsed.table, row);
                    await this.ready();
                    await this.ensureStore(parsed.table);
                    const sn1 = this._findStore(parsed.table);
                    if (sn1) {
                        const tx = this.idb.transaction(sn1, 'readwrite');
                        tx.objectStore(sn1).add(row);
                        await new Promise(r =>
                            { tx.oncomplete = r; tx.onerror = r; tx.onabort = r; });
                    }
                    return { rowsAffected: 1, insertId };
                }

                case 'INSERT_RAW': {
                    const vals = parsed.rawValues.split(',')
                        .map(v => v.trim().replace(/^['"]|['"]$/g, ''));
                    this.cache.insert(parsed.table, { _values: vals });
                    await this.ready();
                    await this.ensureStore(parsed.table);
                    const sn2 = this._findStore(parsed.table);
                    if (sn2) {
                        const tx = this.idb.transaction(sn2, 'readwrite');
                        tx.objectStore(sn2).add({ _values: vals });
                        await new Promise(r =>
                            { tx.oncomplete = r; tx.onerror = r; tx.onabort = r; });
                    }
                    return { rowsAffected: 1 };
                }

                case 'SELECT': {
                    if (this.cache.hasTable(parsed.table)) {
                        let rows = this.cache.getTable(parsed.table);
                        if (parsed.where) {
                            const { conds } = parseWhere(
                                parsed.where, params, 0);
                            if (conds) {
                                rows = rows.filter(row => conds.every(c =>
                                    String(row[c.column]) === String(c.value)));
                            }
                        }
                        rows = applyOrderByLimit(rows, parsed);
                        return { rows: rows.map(r => Object.assign({}, r)) };
                    }

                    await this.ready();
                    const storeName = this._findStore(parsed.table);
                    if (!storeName) {
                        this.cache.createTable(parsed.table);
                        return { rows: [] };
                    }
                    const tx = this.idb.transaction(storeName, 'readonly');
                    const store = tx.objectStore(storeName);
                    const all = await new Promise(resolve => {
                        const req = store.getAll();
                        req.onsuccess = () => resolve(req.result);
                        req.onerror = () => resolve([]);
                    });
                    this.cache.data[parsed.table] = all;
                    this.cache._markDirty(parsed.table);

                    let rows = all;
                    if (parsed.where) {
                        const { conds } = parseWhere(
                            parsed.where, params, 0);
                        if (conds) {
                            rows = rows.filter(row => conds.every(c =>
                                String(row[c.column]) === String(c.value)));
                        }
                    }
                    rows = applyOrderByLimit(rows, parsed);
                    return { rows: rows.map(r => Object.assign({}, r)) };
                }

                case 'UPDATE': {
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
                    // Write to IndexedDB
                    await this.ready();
                    const sn3 = this._findStore(parsed.table);
                    if (sn3) {
                        const tx = this.idb.transaction(sn3, 'readwrite');
                        const store = tx.objectStore(sn3);
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
                            { tx.oncomplete = r; tx.onerror = r; tx.onabort = r; });
                    }
                    return { rowsAffected: affected };
                }

                case 'DELETE': {
                    const { conds } = parseWhere(parsed.where, params, 0);
                    const affected = this.cache.deleteRows(
                        parsed.table, conds);
                    await this.ready();
                    const sn4 = this._findStore(parsed.table);
                    if (sn4) {
                        const tx = this.idb.transaction(sn4, 'readwrite');
                        const store = tx.objectStore(sn4);
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
                            { tx.oncomplete = r; tx.onerror = r; tx.onabort = r; });
                    }
                    return { rowsAffected: affected };
                }

                case 'DROP_TABLE': {
                    this.cache.dropTable(parsed.table);
                    await this.deleteStore(parsed.table);
                    await this.ready();
                    try {
                        const tx = this.idb.transaction('_schema', 'readwrite');
                        tx.objectStore('_schema').delete(parsed.table);
                        await new Promise(r => { tx.oncomplete = r; tx.onabort = r; });
                    } catch (e) { /* non-critical */ }
                    return { rowsAffected: 0 };
                }

                case 'SELECT_MASTER': {
                    // Check cache first (just for table existence)
                    if (this.cache.data &&
                        Object.keys(this.cache.data).length > 0) {
                        return { rows: this.cache.selectMaster(parsed.name) };
                    }
                    await this.ready();
                    if (parsed.name) {
                        return { rows: this._findStore(parsed.name)
                            ? [{ name: parsed.name }] : [] };
                    }
                    const names = this.idb.objectStoreNames;
                    const result = [];
                    for (let i = 0; i < names.length; i++) {
                        const n = names.item(i);
                        if (n !== '_schema') result.push({ name: n });
                    }
                    return { rows: result };
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
            const tablesToCreate = new Set();
            for (const item of this.queue) {
                const parsed = parseSQL(item.sql);
                if (parsed.type === 'CREATE_TABLE' ||
                    parsed.type === 'INSERT' ||
                    parsed.type === 'INSERT_RAW') {
                    tablesToCreate.add(parsed.table);
                }
            }
            if (tablesToCreate.size > 0) {
                try {
                    await this.db.idb.ensureStores([...tablesToCreate]);
                } catch (e) {
                    console.error('[polyfill] batch ensureStores error:', e);
                }
            }

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

            this.db.cache.flushDirty();
        }
    }

    // ── Intercept ────────────────────────────────────────────
    window.openDatabase = function(name, version, displayName, estimatedSize) {
        return new WebSQLDatabase(name);
    };

    console.log('[polyfill] WebSQL -> IndexedDB shim loaded (v7)');
})();
