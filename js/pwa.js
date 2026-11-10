/* SRT Clean - camada PWA: gravação em pasta, ZIP, instalação e service worker */
(function () {
    'use strict';

    // ---------- Toast ----------
    var toastTimer = null, toastCount = 0, toastReset = null;
    function toast(msg) {
        var el = document.getElementById('toast');
        if (!el) return;
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
    }
    window.srtToast = toast;

    // ---------- IndexedDB (guarda a pasta escolhida) ----------
    function idb() {
        return new Promise(function (res, rej) {
            var r = indexedDB.open('srt-clean', 1);
            r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
            r.onsuccess = function () { res(r.result); };
            r.onerror = function () { rej(r.error); };
        });
    }
    function idbGet(k) {
        return idb().then(function (db) {
            return new Promise(function (res, rej) {
                var q = db.transaction('kv').objectStore('kv').get(k);
                q.onsuccess = function () { res(q.result); };
                q.onerror = function () { rej(q.error); };
            });
        });
    }
    function idbSet(k, v) {
        return idb().then(function (db) {
            return new Promise(function (res, rej) {
                var tx = db.transaction('kv', 'readwrite');
                if (v === undefined) tx.objectStore('kv').delete(k); else tx.objectStore('kv').put(v, k);
                tx.oncomplete = function () { res(); };
                tx.onerror = function () { rej(tx.error); };
            });
        });
    }

    // ---------- Pasta de destino ----------
    var FOLDER_NAME = 'SRT Clean';
    var supportsDir = typeof window.showDirectoryPicker === 'function';
    var dirHandle = null;

    function updateFolderUI() {
        var label = document.getElementById('folderLabel');
        var btn = document.getElementById('folderBtn');
        var reset = document.getElementById('folderResetBtn');
        if (!label) return;
        if (!supportsDir) {
            label.textContent = 'Downloads do navegador (use o botão ZIP para agrupar)';
            label.title = 'Este navegador não permite escolher uma pasta. Os ficheiros vão para a pasta de Downloads.';
            if (btn) btn.classList.add('hidden');
            return;
        }
        if (dirHandle) {
            label.textContent = '\u2026/' + FOLDER_NAME;
            label.title = 'Pasta escolhida: ' + FOLDER_NAME;
            reset.classList.remove('hidden');
            btn.textContent = 'Mudar pasta';
        } else {
            label.textContent = 'Downloads (predefinição do navegador)';
            label.title = '';
            reset.classList.add('hidden');
            btn.textContent = 'Escolher pasta';
        }
    }

    window.chooseFolder = async function () {
        if (!supportsDir) return;
        try {
            var picked = await window.showDirectoryPicker({ id: 'srt-clean', mode: 'readwrite', startIn: 'downloads' });
            var target = picked.name === FOLDER_NAME
                ? picked
                : await picked.getDirectoryHandle(FOLDER_NAME, { create: true });
            dirHandle = target;
            await idbSet('dir', target);
            updateFolderUI();
            toast('Pasta pronta: ' + FOLDER_NAME);
        } catch (e) {
            if (e && e.name === 'AbortError') return;
            console.warn(e);
            toast('Pasta não permitida. Crie "' + FOLDER_NAME + '" dentro de Downloads e escolha essa.');
        }
    };

    window.resetFolder = async function () {
        dirHandle = null;
        try { await idbSet('dir', undefined); } catch (e) {}
        updateFolderUI();
        toast('A usar a pasta Downloads do navegador');
    };

    async function ensurePermission(h) {
        var o = { mode: 'readwrite' };
        if ((await h.queryPermission(o)) === 'granted') return true;
        return (await h.requestPermission(o)) === 'granted';
    }

    // ---------- Guardar ficheiro ----------
    function classicDownload(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
    }

    window.saveBlob = async function (blob, filename) {
        if (dirHandle) {
            try {
                if (await ensurePermission(dirHandle)) {
                    var fh = await dirHandle.getFileHandle(filename, { create: true });
                    var w = await fh.createWritable();
                    await w.write(blob);
                    await w.close();
                    toastCount++;
                    toast('Guardado em ' + FOLDER_NAME + (toastCount > 1 ? ' (' + toastCount + ' ficheiros)' : ': ' + filename));
                    clearTimeout(toastReset);
                    toastReset = setTimeout(function () { toastCount = 0; }, 3000);
                    return;
                }
            } catch (e) {
                console.warn('Falha ao gravar na pasta, a usar Downloads:', e);
                toast('Sem acesso à pasta. Toque em "Mudar pasta" e autorize. A usar Downloads.');
            }
        }
        classicDownload(blob, filename);
    };

    // ---------- ZIP (sem compressão) ----------
    var crcTable = (function () {
        var t = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();
    function crc32(buf) {
        var crc = 0xFFFFFFFF;
        for (var i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 255] ^ (crc >>> 8);
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    window.buildZip = function (entries) {
        var enc = new TextEncoder();
        var chunks = [], central = [], offset = 0;
        var d = new Date();
        var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
        var dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
        entries.forEach(function (e) {
            var nameB = enc.encode(e.name), crc = crc32(e.data), size = e.data.length;
            var lh = new DataView(new ArrayBuffer(30));
            lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
            lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
            lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
            lh.setUint16(26, nameB.length, true); lh.setUint16(28, 0, true);
            chunks.push(new Uint8Array(lh.buffer), nameB, e.data);
            var ch = new DataView(new ArrayBuffer(46));
            ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
            ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true);
            ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true);
            ch.setUint32(24, size, true); ch.setUint16(28, nameB.length, true); ch.setUint32(42, offset, true);
            central.push(new Uint8Array(ch.buffer), nameB);
            offset += 30 + nameB.length + size;
        });
        var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
        var end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true);
        end.setUint16(10, entries.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
        return new Blob(chunks.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' });
    };

    // ---------- Instalação ----------
    var deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', function (e) {
        e.preventDefault();
        deferredPrompt = e;
        var b = document.getElementById('installBtn');
        if (b) b.style.display = 'inline-flex';
    });
    window.installApp = async function () {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        var b = document.getElementById('installBtn');
        if (b) b.style.display = 'none';
    };
    window.addEventListener('appinstalled', function () {
        var b = document.getElementById('installBtn');
        if (b) b.style.display = 'none';
    });

    // ---------- Arranque ----------
    document.addEventListener('DOMContentLoaded', async function () {
        if (supportsDir) {
            try { dirHandle = (await idbGet('dir')) || null; } catch (e) { dirHandle = null; }
        }
        updateFolderUI();
    });

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW falhou:', e); });
        });
    }
})();
