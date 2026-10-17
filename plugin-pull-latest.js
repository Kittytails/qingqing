/* 拉取全部最新版（直链插件）
   读出仓库里所有页面文件的清单，逐个从线上重新拿一遍，刷新浏览器缓存。
   以后往仓库里新增文件不用改这里，会自动算进去。
   用法：放在直链同目录，文件名保持 plugin-pull-latest.js（直链会和 plugins.js 一起加载，互不覆盖），
   「设置」→「插件」里点「拉取全部最新版」。 */
(function () {
    if (!window.DL) return;

    // 要刷新的文件类型。以后有别的类型（比如 .wasm），加在这里
    const EXT = /\.(html?|js|css|json|webmanifest|svg|ico|txt|md)$/i;
    const SKIP = /(^|\/)\./;                 // 跳过 .git、.github 之类的隐藏文件
    const LS = k => (localStorage.getItem(k) || '').trim();

    async function gh(path, st) {
        const r = await fetch((st.proxy || 'https://api.github.com') + path, {
            cache: 'no-store',
            headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + st.token, 'X-GitHub-Api-Version': '2022-11-28' }
        });
        if (!r.ok) throw new Error('GitHub ' + r.status);
        return r.json();
    }

    // 仓库文件在网站上的根地址：GitHub Pages 按仓库名推；其它域名就用当前页面所在目录
    function siteRoot(owner, repo) {
        const host = location.hostname.toLowerCase(), o = owner.toLowerCase(), r = repo.toLowerCase();
        if (host === o + '.github.io') return location.origin + (r === o + '.github.io' ? '/' : '/' + encodeURIComponent(repo) + '/');
        return new URL('./', location.href).href;
    }

    async function run(dl) {
        if (!/^https?:$/.test(location.protocol)) return dl.toast('当前是本地文件，没法在线拉取，请从部署的网址打开', 'error');
        if (typeof isBatchUploading !== 'undefined' && isBatchUploading) return dl.toast('正在上传，等上传完再拉取', 'info');
        const st = { token: LS('kb_standalone_token'), repo: LS('kb_standalone_repo'), owner: LS('kb_standalone_owner'), proxy: LS('kb_standalone_proxy').replace(/\/+$/, '') };
        if (!st.token || !st.repo) return dl.toast('先在「设置」里填好 Token 和仓库', 'error');

        dl.toast('正在读取仓库文件列表…', 'loading');
        let files, truncated = false;
        try {
            if (!st.owner) st.owner = (await gh('/user', st)).login || '';
            const tree = await gh('/repos/' + st.owner + '/' + st.repo + '/git/trees/HEAD?recursive=1', st);
            truncated = !!tree.truncated;
            files = (tree.tree || []).filter(x => x.type === 'blob' && EXT.test(x.path) && !SKIP.test(x.path)).map(x => x.path);
        } catch (e) { return dl.toast('读不到仓库文件列表：' + (e.message || '未知错误'), 'error'); }
        if (!files.length) return dl.toast('仓库里没有可刷新的页面文件', 'info');

        try { if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } } catch (_) {}
        const root = siteRoot(st.owner, st.repo);
        const bad = [];
        let ok = 0, i = 0;
        async function worker() {
            while (i < files.length) {
                const p = files[i++];
                try {
                    const r = await fetch(root + p.split('/').map(encodeURIComponent).join('/'), { cache: 'reload' });   // 绕过缓存重新拿，并写回浏览器缓存
                    await r.blob();
                    if (r.ok) ok++; else bad.push(p);   // 404：仓库里有，但网站上还没发布出来
                } catch (_) { bad.push(p); }
                dl.toast('正在拉取 ' + Math.min(i, files.length) + ' / ' + files.length, 'loading');
            }
        }
        await Promise.all(Array.from({ length: 6 }, worker));
        try { if (navigator.serviceWorker) (await navigator.serviceWorker.getRegistrations()).forEach(r => r.update()); } catch (_) {}

        let msg = '已刷新 ' + ok + ' 个文件';
        if (bad.length) msg += '，' + bad.length + ' 个没拉到（' + bad.slice(0, 3).join('、') + (bad.length > 3 ? ' 等' : '') + '）';
        if (truncated) msg += '。仓库文件太多，清单被 GitHub 截断了，有的文件没算进去';
        if (typeof hideToast === 'function') hideToast();
        const go = typeof showConfirm === 'function'
            ? await showConfirm({ title: '拉取完成', message: msg + '。现在刷新，让新版生效？', confirmText: '刷新', cancelText: '稍后' })
            : (dl.toast(msg, bad.length ? 'info' : 'ok'), false);
        if (!go) return;
        try { if (window.parent && window.parent !== window) { window.parent.postMessage({ type: 'reload' }, '*'); return; } } catch (_) {}   // 在小手机里：让小手机整页重载
        location.replace(location.href.split('#')[0].split('?')[0] + '?_=' + Date.now());
    }

    DL.register({
        id: 'pull-all-latest',
        name: '拉取全部最新版',
        desc: '按直链「设置」里填的仓库，把里面所有页面文件（html / js / css / json 等）从线上重新拿一遍，刷新浏览器缓存。以后往仓库里加新文件会自动算进去。',
        run
    });
})();
