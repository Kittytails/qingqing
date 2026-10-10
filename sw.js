/* Direct Link 离线缓存 (v2.0)
 * 放在和 直链.html 同一目录。作用：
 *  1) 页面本身：优先取最新；网络慢（>2.5 秒）或断网时用上次缓存的版本打开
 *  2) 看过的 jsDelivr / raw 缩略图：存起来，断网时资源库还能看
 *  3) 插件文件 plugins.js：优先取最新，断网时用缓存，离线也能用插件
 * 不碰 GitHub API 请求，Token 不会进入缓存。 */
const SHELL = 'dl-shell-2.0';
const IMG = 'dl-img';                  // 图片缓存不跟版本走，升级后保留
const PLUG = 'dl-plugins';             // 插件缓存同样不跟版本走
const IMG_MAX = 400;                   // 最多缓存多少张，超出时删最早的
const IMG_FRESH_MS = 10 * 60 * 1000;   // 非固定版本的图片：缓存超过这个时间，下次用到时在后台刷新
const SLOW_MS = 2500;                  // 网络超过这个时间还没回来，就先用缓存
const IMG_HOSTS = /^(cdn\.jsdelivr\.net|raw\.githubusercontent\.com)$/;
const PLUG_PATH = /\/plugins\.js$/;
// 地址里带完整 commit 哈希 = 固定版本，内容永远不会变，缓存后不用再刷新
const PIN_RE = /(?:@|\/)[0-9a-f]{40}(?:\/|$)/i;
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        // 只清掉旧版本的页面缓存；图片和插件缓存保留
        const keep = [SHELL, IMG, PLUG];
        const names = await caches.keys();
        await Promise.all(names.filter(n => keep.indexOf(n) < 0).map(n => caches.delete(n)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    // 缩略图：只处理 jsDelivr / raw 上的图片。其他跨域请求（包括 api.github.com）一律放行，不经过缓存
    if (url.origin !== self.location.origin) {
        if (IMG_HOSTS.test(url.hostname) && (req.destination === 'image' || IMG_EXT_RE.test(url.pathname))) {
            event.respondWith(imageStrategy(event, req, url));
        }
        return;
    }

    // 插件文件：地址后面带时间戳（?t=），缓存时忽略它
    if (PLUG_PATH.test(url.pathname)) {
        event.respondWith(networkFirst(event, req, PLUG, SLOW_MS));
        return;
    }

    // 页面本身：只管"打开页面"这类请求。页面里自己发的 fetch（检查更新、强制刷新）原样放行
    if (req.mode === 'navigate' || req.destination === 'document') {
        // 「拉取最新版」会带 ?_= 参数打开：这次必须等到最新的，不能因为慢就退回旧缓存（真断网时才用缓存）
        const wantFresh = url.searchParams.has('_') || req.cache === 'reload' || req.cache === 'no-store';
        event.respondWith(networkFirst(event, req, SHELL, wantFresh ? 0 : SLOW_MS));
    }
});

/* 缓存的键：去掉查询参数和 # 部分，这样 ?t= / ?_= 不会让缓存失效 */
function pageKey(url) {
    const u = new URL(url);
    return new Request(u.origin + u.pathname);
}

/* 网络优先：timeoutMs 内网络回来就用网络；超时或失败就用缓存，网络请求在后台继续跑完并更新缓存。
 * timeoutMs 为 0 表示一直等网络，只有网络出错时才退回缓存。 */
async function networkFirst(event, req, cacheName, timeoutMs) {
    const cache = await caches.open(cacheName);
    const key = pageKey(req.url);
    let putDone = Promise.resolve();
    const net = fetch(req).then(res => {
        if (res && res.status === 200) putDone = cache.put(key, res.clone()).catch(() => {});
        return res;
    });
    event.waitUntil(net.then(() => putDone, () => {}));   // 就算已经先返回了缓存，也让后台更新跑完

    const cached = await cache.match(key);
    if (!timeoutMs) {
        try { return await net; }
        catch (e) { if (cached) return cached; throw e; }
    }
    if (!cached) return net;                               // 没有缓存可退：只能等网络
    const timer = new Promise(resolve => setTimeout(() => resolve(null), timeoutMs));
    const first = await Promise.race([net.catch(() => null), timer]);
    return first || cached;
}

/* 图片：有缓存就直接用；非固定版本且缓存太旧时，顺便在后台刷新一次 */
async function imageStrategy(event, req, url) {
    const cache = await caches.open(IMG);
    const key = new Request(url.href);               // 图片地址的查询参数有意义，保留
    const hit = await cache.match(key);
    if (hit) {
        const age = Date.now() - Number(hit.headers.get('x-sw-time') || 0);
        if (age > IMG_FRESH_MS && !PIN_RE.test(url.pathname)) event.waitUntil(refreshImage(cache, key, url));
        return hit;
    }
    const res = await fetch(req);
    // 只存能确认成功的响应（页面给这些图片加了 crossOrigin，所以拿得到真实状态码）；opaque 的不存
    if (res.status === 200 && res.type !== 'opaque') event.waitUntil(storeImage(cache, key, res.clone()));
    return res;
}

async function refreshImage(cache, key, url) {
    try {
        const res = await fetch(url.href, { mode: 'cors', credentials: 'omit' });
        if (res.status === 200) await storeImage(cache, key, res);
    } catch (_) { /* 没网就保留旧的 */ }
}

async function storeImage(cache, key, res) {
    try {
        // 加一个存入时间，用来判断"是否太旧"。body 已被浏览器解码过，所以去掉 content-encoding / content-length
        const h = new Headers(res.headers);
        h.delete('content-encoding');
        h.delete('content-length');
        h.set('x-sw-time', String(Date.now()));
        await cache.put(key, new Response(await res.blob(), { status: 200, statusText: 'OK', headers: h }));
        const keys = await cache.keys();                       // 按存入顺序排列，最早的在前
        if (keys.length > IMG_MAX) await Promise.all(keys.slice(0, keys.length - IMG_MAX).map(k => cache.delete(k)));
    } catch (_) { /* 存不下（空间不足等）就算了，不影响显示 */ }
}
