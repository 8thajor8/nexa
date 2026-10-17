import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

interface HomeEffectPickerProps {
  id: string;
  lightName: string;
  effects: readonly string[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

interface MenuPosition { top: number; left: number; width: number; maxHeight: number; }

function afterFrame(callback: () => void) {
  if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(callback);
  else window.setTimeout(callback, 0);
}

function menuPosition(trigger: HTMLButtonElement, effectsCount: number): MenuPosition {
  const rect = trigger.getBoundingClientRect();
  const viewportWidth = window.innerWidth || 1024;
  const viewportHeight = window.innerHeight || 768;
  const headerBottom = document.querySelector<HTMLElement>(".workspace-header")?.getBoundingClientRect().bottom ?? 0;
  const safeTop = Math.min(Math.max(8, headerBottom + 8), Math.max(8, viewportHeight - 80));
  const maxHeight = Math.max(72, Math.min(280, viewportHeight - safeTop - 16));
  const naturalHeight = Math.min(maxHeight, Math.max(48, effectsCount * 38 + 12));
  const roomBelow = Math.max(0, viewportHeight - rect.bottom - 8);
  const roomAbove = Math.max(0, rect.top - safeTop - 8);
  const openAbove = roomBelow < naturalHeight && roomAbove > roomBelow;
  const availableHeight = Math.max(48, Math.min(naturalHeight, openAbove ? roomAbove : roomBelow || naturalHeight));
  const width = Math.min(Math.max(220, rect.width), Math.max(0, viewportWidth - 16));
  const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
  const top = openAbove
    ? Math.max(safeTop, rect.top - availableHeight - 6)
    : Math.max(safeTop, Math.min(rect.bottom + 6, viewportHeight - availableHeight - 8));
  return { top, left, width, maxHeight: availableHeight };
}

export function HomeEffectPicker({ id, lightName, effects, value, disabled, onChange }: HomeEffectPickerProps) {
  const generatedId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const menuId = `home-effect-menu-${generatedId}`;
  const activeOption = (index: number) => menuRef.current?.querySelector<HTMLElement>(`[data-effect-index="${index}"]`);

  function focusOption(index: number) {
    if (effects.length === 0) return;
    const nextIndex = Math.max(0, Math.min(effects.length - 1, index));
    setActiveIndex(nextIndex);
    afterFrame(() => {
      const option = activeOption(nextIndex);
      option?.focus();
      option?.scrollIntoView?.({ block: "nearest" });
    });
  }

  function close(restoreFocus: boolean) {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) afterFrame(() => triggerRef.current?.focus());
  }

  function toggle() {
    if (disabled || effects.length === 0) return;
    if (open) { close(true); return; }
    const initialIndex = Math.max(0, effects.indexOf(value));
    setActiveIndex(initialIndex);
    setPosition(menuPosition(triggerRef.current!, effects.length));
    setOpen(true);
    focusOption(initialIndex);
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close(false);
    };
    const updatePosition = () => {
      if (triggerRef.current) setPosition(menuPosition(triggerRef.current, effects.length));
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, effects.length]);

  function choose(effect: string) {
    onChange(effect);
    close(true);
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); close(true); }
    else if (event.key === "ArrowDown") { event.preventDefault(); focusOption(activeIndex + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); focusOption(activeIndex - 1); }
    else if (event.key === "Home") { event.preventDefault(); focusOption(0); }
    else if (event.key === "End") { event.preventDefault(); focusOption(effects.length - 1); }
    else if ((event.key === "Enter" || event.key === " ") && effects[activeIndex]) {
      event.preventDefault(); choose(effects[activeIndex]);
    }
  }

  const menu = open && position && typeof document !== "undefined" ? createPortal(
    <div ref={menuRef} id={menuId} className="home-effect-picker__menu" role="listbox"
      aria-label={`Efectos disponibles para ${lightName}`} aria-activedescendant={`${menuId}-option-${activeIndex}`}
      onKeyDown={handleMenuKeyDown} style={position}>
      {effects.map((effect, index) => <div id={`${menuId}-option-${index}`} key={effect}
        className="home-effect-picker__option" role="option" aria-selected={value === effect}
        data-effect-index={index} tabIndex={activeIndex === index ? 0 : -1}
        onFocus={() => setActiveIndex(index)} onClick={() => choose(effect)}>
        <span>{effect}</span>{value === effect && <span className="home-effect-picker__check" aria-hidden="true">✓</span>}
      </div>)}
    </div>, document.body) : null;

  return <>
    <button ref={triggerRef} id={id} type="button" className="home-effect-picker__trigger"
      aria-label={`Elegir un efecto para ${lightName}`} aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open ? menuId : undefined} disabled={disabled || effects.length === 0} onClick={toggle}>
      <span>{value || "Elegí un efecto"}</span><span className="home-effect-picker__chevron" aria-hidden="true">⌄</span>
    </button>
    {menu}
  </>;
}
