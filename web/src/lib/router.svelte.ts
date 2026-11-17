import { usage } from './usage';

export type RouteName = 'inbox' | 'done' | 'all' | 'snoozed' | 'sources' | 'source' | 'settings' | 'stats';

export interface RouteState {
  route: RouteName;
  params: { id?: string };
  query: Record<string, string>;
}

export function parseLocation(pathname: string, search: string): RouteState {
  const query: Record<string, string> = {};
  new URLSearchParams(search).forEach((v, k) => (query[k] = v));
  const parts = pathname.split('/').filter(Boolean);
  const [a, b] = parts;
  switch (a) {
    case 'done':
    case 'all':
    case 'snoozed':
      return { route: a, params: {}, query };
    case 'settings':
    case 'stats':
      return { route: a, params: {}, query };
    case 'sources':
      return b ? { route: 'source', params: { id: b }, query } : { route: 'sources', params: {}, query };
    default:
      return { route: 'inbox', params: {}, query };
  }
}

export function buildPath(route: RouteName, params: { id?: string } = {}, query: Record<string, string> = {}): string {
  const base = route === 'source' ? `/sources/${params.id ?? ''}` : route === 'inbox' ? '/inbox' : `/${route}`;
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) u.set(k, v);
  const s = u.toString();
  return s ? `${base}?${s}` : base;
}

class Router {
  state = $state<RouteState>({ route: 'inbox', params: {}, query: {} });

  get route(): RouteName {
    return this.state.route;
  }
  get query(): Record<string, string> {
    return this.state.query;
  }
  get params() {
    return this.state.params;
  }

  constructor() {
    if (typeof window !== 'undefined') {
      this.sync();
      window.addEventListener('popstate', () => this.sync());
    }
  }

  private sync() {
    const prev = this.state;
    this.state = parseLocation(window.location.pathname, window.location.search);
    // Opening a view: counted once per change of view. The view the app starts on is counted at boot, once usage runs.
    if (prev.route !== this.state.route || prev.params.id !== this.state.params.id) {
      usage.count(`view.${this.state.route}`);
    }
  }

  navigate(
    route: RouteName,
    query: Record<string, string> = {},
    opts: { replace?: boolean; id?: string | number; hash?: string } = {},
  ) {
    let path = buildPath(route, { id: opts.id === undefined ? undefined : String(opts.id) }, query);
    // A hash names a section of the page to land on (Settings reads it); the router itself ignores it.
    if (opts.hash) path += `#${opts.hash}`;
    if (path === window.location.pathname + window.location.search + window.location.hash) return;
    if (opts.replace) history.replaceState(null, '', path);
    else history.pushState(null, '', path);
    this.sync();
  }

  /** Merge query params on the current route (empty string removes). */
  setQuery(patch: Record<string, string | undefined>, opts: { replace?: boolean } = { replace: true }) {
    const next = { ...this.state.query };
    for (const [k, v] of Object.entries(patch)) {
      if (v) next[k] = v;
      else delete next[k];
    }
    this.navigate(this.state.route, next, { ...opts, id: this.state.params.id });
  }
}

export const router = new Router();
