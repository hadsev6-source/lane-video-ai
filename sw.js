/* LANE AI STUDIO — Web Push service worker */
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch (_) { payload = { body: event.data ? event.data.text() : "Имате ново известие." }; }

  const title = typeof payload.title === "string" && payload.title ? payload.title : "LANE AI STUDIO";
  const options = {
    body: typeof payload.body === "string" ? payload.body : "Имате ново известие.",
    tag: typeof payload.tag === "string" ? payload.tag : "lane-ai-notification",
    renotify: Boolean(payload.renotify),
    data: { url: typeof payload.url === "string" && payload.url.startsWith("/") ? payload.url : "/admin" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.url ? event.notification.data.url : "/admin";
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        await client.focus();
        if ("navigate" in client) await client.navigate(target);
        return;
      }
    }
    if (clients.openWindow) await clients.openWindow(target);
  })());
});
