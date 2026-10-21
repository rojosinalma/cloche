// Image viewer: fit to the stage, or actual size with the zoom button, a
// click on the image, Space or Z.
export function mount(ctx) {
  const img = ctx.$('[data-role="img"]');
  const zoomBtn = ctx.$('[data-role="zoom"]');
  img.alt = ctx.item.name;
  img.src = ctx.src;

  const setZoom = (on) => {
    ctx.box.classList.toggle('zoomed', on);
    zoomBtn.querySelector('use').setAttribute('href', `/tailor/icons.svg#bi-${on ? 'zoom-out' : 'zoom-in'}`);
    if (on) {
      const { stage } = ctx;
      stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2;
      stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
    }
  };
  const toggle = () => setZoom(!ctx.box.classList.contains('zoomed'));
  img.addEventListener('click', toggle, { signal: ctx.signal });
  zoomBtn.addEventListener('click', toggle, { signal: ctx.signal });

  return {
    key(e) {
      if (e.key !== ' ' && e.key !== 'z') return false;
      toggle();
      return true;
    },
    hide: () => setZoom(false),
    dispose: () => { setZoom(false); img.removeAttribute('src'); }
  };
}
