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
    <nav className="flex items-center gap-2 px-4 text-12" aria-label="Breadcrumb navigation">
      {items.map((item, index) => (
        <div key={index} className="flex items-center gap-2">
          {index > 0 && (
            <span className="text-fg-3" aria-hidden="true" data-testid="breadcrumb-separator">
              &gt;
            </span>
          )}
          {item.path ? (
            <a
              href={item.path}
              className="text-fg-3 no-underline [transition:color_.2s] hover:text-fg-2 hover:underline"
            >
              {item.label}
            </a>
          ) : (
            <span className="font-medium text-fg-2" aria-current="page">
              {item.label}
            </span>
          )}
        </div>
      ))}
    </nav>
  );
}
