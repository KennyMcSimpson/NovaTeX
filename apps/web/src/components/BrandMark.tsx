import React from 'react';

interface BrandMarkProps {
  size?: number;
  className?: string;
}

/**
 * NovaTeX editorial studio emblem:
 * Minimal geometric botanical leaf fused with a precision drafting nib
 * in refined Overleaf Forest Emerald (#0F7B4C) — razor-sharp on light and dark topbars.
 */
export const BrandMark: React.FC<BrandMarkProps> = ({ size = 26, className }) => {
  const radius = Math.max(6, Math.round(size * 0.27));
  const glyphSize = Math.round(size * 0.62);

  return (
    <span
      className={className ? `brand-mark ${className}` : 'brand-mark'}
      style={{ width: size, height: size, borderRadius: radius }}
      aria-hidden="true"
    >
      <svg
        width={glyphSize}
        height={glyphSize}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Minimal geometric leaf / calligraphy nib silhouette */}
        <path
          d="M19.5 4.5C13.4 4.8 8.3 7.8 5.8 13.4C5.1 15 4.7 17 4.5 19.5C7 19.3 9 18.9 10.6 18.2C16.2 15.7 19.2 10.6 19.5 4.5Z"
          fill="rgba(255, 255, 255, 0.14)"
          stroke="#FFFFFF"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Precision nib slit */}
        <path
          d="M5 19L12.4 11.6"
          stroke="#FFFFFF"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        {/* Minimal breather point */}
        <circle cx="14.1" cy="9.9" r="1.45" fill="#FFFFFF" />
      </svg>
    </span>
  );
};
