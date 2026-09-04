/**
 * Everything in one self-contained file, for a page with no build step.
 *
 * The other entry points are deliberately split — a site that trusts its own
 * documents skips the validator, and importing a player registers no element —
 * but that split assumes a bundler or a CDN willing to follow shared chunks.
 * A page that loads files straight from disk has neither, so this entry pays
 * for all three at once and `vite.standalone.config.ts` inlines them:
 *
 * ```html
 * <script type="module" src="./assets/line-bird.standalone.js"></script>
 * <line-bird src="./bird.json" style="height: 320px"></line-bird>
 * ```
 *
 * Importing it also registers `<line-bird>`, so the tag works with no further
 * code, while `mount()` and `AnimationPlayer` stay available to import from it.
 */
import './element.ts';

export * from './index.ts';
export { LineBirdElement, defineLineBirdElement } from './element.ts';
export { validateProject, type ValidationResult } from './validate.ts';
