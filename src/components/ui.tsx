'use client';
import type { ReactNode } from 'react';
export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) { return <div className={`card ${className}`}>{children}</div>; }
export function SectionLabel({ children }: { children: ReactNode }) { return <div className="eyebrow">{children}</div>; }
