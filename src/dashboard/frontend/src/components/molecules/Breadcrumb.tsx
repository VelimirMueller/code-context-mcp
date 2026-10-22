'use client';

interface BreadcrumbItem {
  label: string;
  path?: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
}

export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb navigation" style={{ paddingLeft: 16, paddingRight: 16 }}>
      {items.map((item, index) => (
        <div key={index} className="breadcrumb-item">
          {index > 0 && (
            <span className="breadcrumb-separator" aria-hidden="true">
              &gt;
            </span>
          )}
          {item.path ? (
            <a href={item.path} className="breadcrumb-link">
              {item.label}
            </a>
          ) : (
            <span className="breadcrumb-current" aria-current="page">
              {item.label}
            </span>
          )}
        </div>
      ))}
    </nav>
  );
}
