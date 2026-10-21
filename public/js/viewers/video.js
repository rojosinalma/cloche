// Video viewer: the browser's player; pauses when another tab or file takes over.
export function mount(ctx) {
  const video = ctx.$('[data-role="video"]');
  video.src = ctx.src;
  video.play().catch(() => {});
  return {
    hide: () => video.pause(),
    dispose: () => { video.pause(); video.removeAttribute('src'); video.load(); }
  };
}
