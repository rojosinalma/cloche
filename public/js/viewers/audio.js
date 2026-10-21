// Audio viewer: the browser's player; pauses when another tab or file takes over.
export function mount(ctx) {
  const audio = ctx.$('[data-role="audio"]');
  audio.src = ctx.src;
  audio.play().catch(() => {});
  return {
    hide: () => audio.pause(),
    dispose: () => { audio.pause(); audio.removeAttribute('src'); }
  };
}
