import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Vercel Blob — every cover/thumbnail/still the studio renders. Letting
    // next/image optimize them turns multi-MB 2K originals into ~30KB WebP
    // card variants (the dashboard was loading full-res files as covers).
    remotePatterns: [
      { protocol: "https", hostname: "*.public.blob.vercel-storage.com" },
    ],
  },
};

export default nextConfig;
