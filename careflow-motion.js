(() => {
  const { animate, inView, stagger, hover } = window.Motion || {};
  if (!animate || !inView || !stagger) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) return;

  const hero = document.querySelector('.public-hero');
  const header = document.querySelector('.public-header');
  if (header) animate(header, { opacity: [0, 1], y: [-10, 0] }, { duration: 0.34, ease: 'easeOut' });
  if (hero) {
    const copy = hero.querySelector(':scope > div:first-child');
    const preview = hero.querySelector('.queue-preview');
    if (copy) animate(copy, { opacity: [0, 1], y: [16, 0] }, { duration: 0.46, delay: 0.06, ease: 'easeOut' });
    if (preview) animate(preview, { opacity: [0, 1], y: [18, 0], scale: [0.985, 1] }, { duration: 0.52, delay: 0.12, ease: 'easeOut' });
  }

  let featureIntroPlayed = false;
  const features = document.querySelector('#features');
  if (features) inView(features, () => {
    if (featureIntroPlayed) return;
    featureIntroPlayed = true;
    const cards = features.querySelectorAll('.feature-card');
    animate(cards, { opacity: [0, 1], y: [14, 0] }, { duration: 0.38, delay: stagger(0.055), ease: 'easeOut' });
  }, { amount: 0.08 });

  if (hover) document.querySelectorAll('.feature-card,.how-card,.facility-card').forEach(card => {
    hover(card, () => {
      animate(card, { y: -3 }, { duration: 0.18, ease: 'easeOut' });
      return () => animate(card, { y: 0 }, { duration: 0.18, ease: 'easeOut' });
    });
  });

  document.addEventListener('click', event => {
    if (!event.target.closest('[data-nav]')) return;
    window.setTimeout(() => {
      const active = document.querySelector('.view.active');
      if (!active) return;
      const items = active.querySelectorAll('.page-head,.patient-hero,.highlight,.grid4>.card,.cols>.panel,.panel.table-panel,.facility-card');
      if (items.length) animate(items, { opacity: [0, 1], y: [8, 0] }, { duration: 0.24, delay: stagger(0.025), ease: 'easeOut' });
    }, 0);
  });

  const modalBackdrop = document.querySelector('.modal-backdrop');
  if (modalBackdrop) new MutationObserver(() => {
    if (!modalBackdrop.classList.contains('open')) return;
    const dialog = modalBackdrop.querySelector('.modal');
    if (dialog) animate(dialog, { opacity: [0, 1], y: [10, 0], scale: [0.985, 1] }, { duration: 0.2, ease: 'easeOut' });
  }).observe(modalBackdrop, { attributes: true, attributeFilter: ['class'] });
})();
