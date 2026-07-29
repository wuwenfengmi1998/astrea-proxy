// Session.getMobileOption override
// Reads mobile options directly from the polyfill's localStorage cache,
// bypassing the async store load. This ensures options are available
// synchronously when initSecurity checks them on page refresh.
(function() {
    'use strict';

    var DB_NAME = 'AsteaMobileDB';
    var CACHE_PREFIX = '__pcf_' + DB_NAME + '_';

    function getOptionFromCache(optionId) {
        if (!optionId) return null;
        var idStr = String(optionId);
        // Try both common table name casings
        var tableKeys = [
            CACHE_PREFIX + 'mobileoptions',
            CACHE_PREFIX + 'MOBILEOPTIONS',
            CACHE_PREFIX + 'MobileOptions'
        ];
        for (var i = 0; i < tableKeys.length; i++) {
            try {
                var raw = localStorage.getItem(tableKeys[i]);
                if (!raw) continue;
                var rows = JSON.parse(raw);
                for (var j = 0; j < rows.length; j++) {
                    var row = rows[j];
                    if (String(row.Key) === idStr) {
                        var parsed = JSON.parse(row.Value);
                        if (parsed && parsed.records &&
                            parsed.records.length > 0) {
                            var opt = parsed.records[0];
                            return {
                                id: opt.id,
                                description: opt.description || '',
                                stringValue: opt.stringValue || '',
                                booleanValue: opt.booleanValue !== undefined
                                    ? opt.booleanValue : true,
                                floatValue: opt.floatValue !== undefined
                                    ? opt.floatValue : -1,
                                valueTypes: opt.valueTypes || ''
                            };
                        }
                    }
                }
            } catch (e) { /* ignore parse errors */ }
        }
        return null;
    }

    function tryOverride() {
        if (typeof Session === 'undefined' || !Session ||
            !Session.getMobileOption) {
            setTimeout(tryOverride, 50);
            return;
        }
        var original = Session.getMobileOption;
        Session.getMobileOption = function(optionId) {
            var cached = getOptionFromCache(optionId);
            if (cached) return cached;
            // Fallback to original (reads from store)
            return original.call(this, optionId);
        };
        console.log('[session-override] getMobileOption overridden');
    }

    tryOverride();
})();
