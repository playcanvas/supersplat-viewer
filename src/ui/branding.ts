import type { ViewerBranding, ViewerBrandingLink } from '../options';

// Only these open as links. The urls can come from a generated document's bootstrap, and a
// `javascript:` one would run in this page when clicked
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

const isSafeHref = (href: string) => {
    try {
        return SAFE_PROTOCOLS.has(new URL(href, document.baseURI).protocol);
    } catch (_e) {
        return false;
    }
};

// built from text and attributes rather than markup, so a label cannot inject any
const createLink = ({ label, href }: ViewerBrandingLink) => {
    const link = document.createElement('a');
    link.className = 'sse-infoLink';
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const text = document.createElement('span');
    text.textContent = label;
    link.appendChild(text);
    return link;
};

// Apply the host's branding to the info panel. Anything left out keeps the viewer's own
const initBranding = (root: HTMLElement, branding: ViewerBranding) => {
    const { title, logo, links } = branding;

    if (title !== undefined || logo !== undefined) {
        // the host's identity: the viewer's version and its link to the SuperSplat repository
        // would read as the host's, so drop them
        const titleBlock = root.querySelector<HTMLAnchorElement>('.sse-viewerTitle');
        titleBlock.removeAttribute('href');
        root.querySelector('.sse-title-version').classList.add('sse-hidden');

        if (title !== undefined) {
            root.querySelector('.sse-title-name').textContent = title;
        }

        if (logo !== undefined) {
            // decorative beside the title, as the svg it replaces is
            const image = document.createElement('img');
            image.className = 'sse-viewerLogo';
            image.src = logo;
            image.alt = '';
            root.querySelector('.sse-viewerLogo').replaceWith(image);
        }
    }

    if (links !== undefined) {
        const container = root.querySelector('.sse-infoLinks');
        const shown = links === false ? [] : links.filter((link) => isSafeHref(link.href));
        container.replaceChildren(...shown.map(createLink));
        container.classList.toggle('sse-hidden', shown.length === 0);
    }
};

export { initBranding };
