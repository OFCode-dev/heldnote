// The public experience never opens the note database or token cache.
// Preserve the installed app's existing start URL and identity.
if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true) {
  window.location.replace('/app');
} else {
  const controls = document.querySelector('.revision-controls');
  const preview = document.getElementById('demo-text');
  const label = document.getElementById('demo-version');
  if (controls && preview && label) {
    controls.hidden = false;
    const versions = JSON.parse(document.getElementById('demo-versions').textContent);
    for (const button of controls.querySelectorAll('button')) {
      button.addEventListener('click', () => {
        const version = versions[Number(button.dataset.version)];
        preview.textContent = version.text;
        label.textContent = version.label;
        for (const other of controls.querySelectorAll('button')) {
          other.setAttribute('aria-pressed', String(other === button));
        }
      });
    }
  }
}
