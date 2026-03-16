import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

const tooltipStyles = `
.tooltip-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  cursor: help;
}

.tooltip-term {
  border-bottom: 1px dotted #555;
}

.tooltip-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #222;
  color: #666;
  font-size: 9px;
  font-weight: 600;
  flex-shrink: 0;
  line-height: 1;
}

.tooltip-popup {
  position: fixed;
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
  color: #ccc;
  min-width: 200px;
  max-width: min(340px, calc(100vw - 24px));
  z-index: 99999;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(0,0,0,0.5);
  white-space: pre-line;
  word-wrap: break-word;
}
`;

const STYLE_ID = "tooltip-styles";

export default function Tooltip({ children, text, noUnderline }) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: -9999, left: -9999 });
  const wrapperRef = useRef(null);
  const popupRef = useRef(null);

  useEffect(() => {
    // Use ID so HMR replaces the old style instead of duplicating
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = tooltipStyles;
  }, []);

  const reposition = useCallback(() => {
    if (!popupRef.current || !wrapperRef.current) return;

    const wrapperRect = wrapperRef.current.getBoundingClientRect();
    const popupRect = popupRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = wrapperRect.top - popupRect.height - 8;
    let left = wrapperRect.left + wrapperRect.width / 2 - popupRect.width / 2;

    // If tooltip would go above viewport, flip below
    if (top < 4) {
      top = wrapperRect.bottom + 8;
    }

    // Keep within horizontal bounds
    if (left < 8) left = 8;
    if (left + popupRect.width > vw - 8) left = vw - popupRect.width - 8;

    // Keep within vertical bounds
    if (top + popupRect.height > vh - 8) {
      top = vh - popupRect.height - 8;
    }

    setPos({ top, left });
  }, []);

  // Position after the popup renders so we can measure it
  useEffect(() => {
    if (visible) {
      // Use rAF to ensure the popup is rendered before measuring
      requestAnimationFrame(() => reposition());
    }
  }, [visible, reposition]);

  return (
    <span
      className="tooltip-wrapper"
      ref={wrapperRef}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      <span className={noUnderline ? undefined : "tooltip-term"}>{children}</span>
      <span className="tooltip-icon">?</span>
      {visible && createPortal(
        <span
          className="tooltip-popup"
          ref={popupRef}
          style={{ top: pos.top, left: pos.left }}
        >
          {text}
        </span>,
        document.body
      )}
    </span>
  );
}
