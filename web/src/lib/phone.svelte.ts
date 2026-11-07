// Reactive "phone layout" flag. Mirrors the `(max-width: 899px)` CSS breakpoint so components that need to
// change markup (not just styles) for finger-sized controls stay in step with the stylesheets.
class Phone {
  value = $state(false);
  constructor() {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 899px)');
    this.value = mq.matches;
    mq.addEventListener('change', (e) => (this.value = e.matches));
  }
}
export const phone = new Phone();
