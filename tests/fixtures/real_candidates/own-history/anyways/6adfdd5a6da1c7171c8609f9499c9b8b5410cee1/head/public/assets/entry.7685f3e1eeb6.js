const newsroom = location.pathname.startsWith('/newsroom');
const newsroomCss = "/assets/design.a1fea784002a.css";
const cssLink = document.querySelector('link[data-public-css]');
if (newsroom) {
  document.body.classList.remove('public-site');
  document.body.classList.add('newsroom-site');
  if (cssLink) cssLink.disabled = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = newsroomCss;
  document.head.append(link);
}
await import(newsroom ? "/assets/newsroom.59379c134825.js" : "/assets/public.0c05fbc55f13.js").catch(error => {
  console.error('Anyways application failed to start', error);
  const app = document.querySelector('#app');
  if (app) app.innerHTML = '<div class="lost"><p class="mono">[ interference ]</p><h1>The desk is temporarily unavailable.</h1><p>Reload to try again.</p></div>';
});
