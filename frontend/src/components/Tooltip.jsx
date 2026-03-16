import React, { useState, useRef, useEffect } from "react";

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
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
  color: #ccc;
  max-width: 280px;
  width: max-content;
  z-index: 1000;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}

.tooltip-popup::after {
  content: "";
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 6px solid transparent;
  border-top-color: #333;
}

.tooltip-popup::before {
  content: "";
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-top-color: #1a1a1a;
  z-index: 1;
}
`;

let stylesInjected = false;

export default function Tooltip({ children, text, noUnderline }) {
  const [visible, setVisible] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const popupRef = useRef(null);
  const wrapperRef = useRef(null);

  useEffect(() => {
    if (!stylesInjected) {
      const style = document.createElement("style");
      style.textContent = tooltipStyles;
      document.head.appendChild(style);
      stylesInjected = true;
    }
  }, []);

  useEffect(() => {
    if (visible && popupRef.current && wrapperRef.current) {
      const rect = popupRef.current.getBoundingClientRect();
      // If tooltip goes above viewport, flip to below
      if (rect.top < 4) {
        setFlipped(true);
      } else {
        setFlipped(false);
      }
    }
  }, [visible]);

  const flippedStyle = flipped
    ? {
        bottom: "auto",
        top: "calc(100% + 8px)",
      }
    : {};

  return (
    <span
      className="tooltip-wrapper"
      ref={wrapperRef}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => {
        setVisible(false);
        setFlipped(false);
      }}
    >
      <span className={noUnderline ? undefined : "tooltip-term"}>{children}</span>
      <span className="tooltip-icon">?</span>
      {visible && (
        <span className="tooltip-popup" ref={popupRef} style={flippedStyle}>
          {text}
        </span>
      )}
    </span>
  );
}
