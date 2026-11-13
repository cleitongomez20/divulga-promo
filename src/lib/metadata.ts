import shareImage from '@/assets/divulga-promo-share.jpg.asset.json';

const shareImageUrl = `https://divulga-promo.lovable.app${shareImage.url}`;

export function pageHead(title: string, description: string) {
  return { meta: [{ title: `${title} | Divulga Promo` }, { name: 'description', content: description }, { property: 'og:title', content: `${title} | Divulga Promo` }, { property: 'og:description', content: description }, { property: 'og:type', content: 'website' }, { name: 'twitter:card', content: 'summary_large_image' }, { property: 'og:image', content: shareImageUrl }, { property: 'og:image:width', content: '1200' }, { property: 'og:image:height', content: '630' }, { property: 'og:image:type', content: 'image/jpeg' }, { property: 'og:image:alt', content: 'Logo Divulga Promo' }, { name: 'twitter:image', content: shareImageUrl }] };
}