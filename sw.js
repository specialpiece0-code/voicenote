/* 보이스노트 서비스 워커 — network-first (절대 stale 캐시를 우선하지 않음)
   네트워크 성공 시 캐시 갱신, 실패(오프라인) 시에만 캐시 폴백. */
const CACHE = 'voicenote-v16';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 같은 출처의 GET만 처리 (CDN·API 요청은 그대로 통과)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return resp;
      })
      .catch(() =>
        caches.match(e.request).then(cached => cached || new Response('오프라인 상태이며 캐시된 사본이 없습니다.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain;charset=utf-8' }
        }))
      )
  );
});
