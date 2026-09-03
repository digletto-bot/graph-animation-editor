type Child = Node | string | null | undefined | false;

export interface ElementOptions {
  class?: string;
  text?: string;
  title?: string;
  type?: string;
  value?: string | number;
  placeholder?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  checked?: boolean;
  disabled?: boolean;
  html?: string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (event: never) => void>>;
}

/** Terse element factory — keeps UI modules readable without a framework. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.class) element.className = options.class;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.html !== undefined) element.innerHTML = options.html;
  if (options.title) element.title = options.title;
  if (options.dataset) {
    for (const key of Object.keys(options.dataset)) element.dataset[key] = options.dataset[key];
  }
  if (options.attrs) {
    for (const key of Object.keys(options.attrs)) element.setAttribute(key, options.attrs[key]!);
  }

  const anyElement = element as unknown as Record<string, unknown>;
  if (options.type !== undefined) anyElement.type = options.type;
  if (options.value !== undefined) anyElement.value = String(options.value);
  if (options.placeholder !== undefined) anyElement.placeholder = options.placeholder;
  if (options.min !== undefined) anyElement.min = String(options.min);
  if (options.max !== undefined) anyElement.max = String(options.max);
  if (options.step !== undefined) anyElement.step = String(options.step);
  if (options.checked !== undefined) anyElement.checked = options.checked;
  if (options.disabled !== undefined) anyElement.disabled = options.disabled;

  if (options.on) {
    for (const key of Object.keys(options.on)) {
      const handler = options.on[key as keyof HTMLElementEventMap];
      if (handler) element.addEventListener(key, handler as EventListener);
    }
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return element;
}

export function clear(element: HTMLElement): void {
  while (element.firstChild) element.removeChild(element.firstChild);
}

/** Label + control row used throughout the inspector. */
export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field', title: hint ?? '' }, [
    h('span', { class: 'field-label', text: label }),
    control,
  ]);
}

export function button(
  label: string,
  onClick: () => void,
  options: { class?: string; title?: string } = {},
): HTMLButtonElement {
  return h('button', {
    class: options.class ?? 'btn',
    text: label,
    title: options.title ?? '',
    type: 'button',
    on: { click: onClick as (event: never) => void },
  });
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = dataUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
  );
}
