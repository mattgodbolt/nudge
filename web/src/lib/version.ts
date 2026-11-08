declare const __BUILD_VERSION__: string | undefined;

/** The commit this page was built from (injected by Vite); 'dev' under tests. */
export const BUILD_VERSION: string = typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : 'dev';
