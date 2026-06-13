function toBase64Url(str) {
	const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(str)));
	return base64
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, ''); // Remove padding character
}

// Helper to fetch includes with aggressive caching and proactive background refreshing
async function fetchIncludeWithCache(resolvedUrl, ctx) {
	const cache = caches.default;
	// Create a unique cache key for the include file using its absolute URL
	const cacheKey = new Request(resolvedUrl, { method: 'GET' });

	// Check the Cloudflare Edge Cache
	let cachedResponse = await cache.match(cacheKey);

	if (cachedResponse) {
		// Proactive background refresh logic
		const dateHeader = cachedResponse.headers.get('Date');
		const age = dateHeader ? (Date.now() - new Date(dateHeader).getTime()) / 1000 : Infinity;

		// If cached content is older than 30 minutes, refresh it in the background.
		// Cache entries expire at max-age=3600 (1 hour). Any request between 30–60 min
		// serves stale content and refreshes in the background, keeping the entry alive.
		if (age > 1800) {
			ctx.waitUntil(
				fetch(resolvedUrl)
					.then(freshResp => {
						if (freshResp.ok) {
							const newHeaders = new Headers();
							newHeaders.set('Cache-Control', 'public, max-age=3600');
							newHeaders.set('Date', new Date().toUTCString());
							const responseToCache = new Response(freshResp.body, { headers: newHeaders });
							return cache.put(cacheKey, responseToCache);
						}
					})
					.catch(err => console.error(`Background refresh failed for ${resolvedUrl}:`, err))
			);
		}

		return await cachedResponse.text();
	}

	// Cache Miss: Fetch synchronously right now
	try {
		const response = await fetch(resolvedUrl);
		if (!response.ok) {
			console.error(`Include fetch failed for ${resolvedUrl}: ${response.status} ${response.statusText}`);
			return ``;
		}

		const content = await response.text();

		// Cache it for future requests
		const newHeaders = new Headers();
		newHeaders.set('Cache-Control', 'public, max-age=3600');
		newHeaders.set('Date', new Date().toUTCString());
		const responseToCache = new Response(content, { headers: newHeaders });

		ctx.waitUntil(cache.put(cacheKey, responseToCache));

		return content;
	} catch (e) {
		console.error(`Include fetch error for ${resolvedUrl}:`, e);
		return ``;
	}
}

// HTML Rewriter Element Handler for <include src="..." />
class IncludeHandler {
	constructor(ctx, baseUrl) {
		this.ctx = ctx;
		this.baseUrl = baseUrl; // The current page's target GitHub URL
	}

	async element(element) {
		const src = element.getAttribute('src');
		if (src) {
			try {
				const resolved = new URL(src, this.baseUrl);
				if (resolved.origin !== new URL(this.baseUrl).origin) {
					console.error(`Include blocked for ${src}: must resolve to same origin`);
					element.replace('', { html: true });
					return;
				}

				const resolvedUrl = resolved.toString();

				const content = await fetchIncludeWithCache(resolvedUrl, this.ctx);
				element.replace(content, { html: true });
			} catch (e) {
				console.error(`Include handler error for ${src}:`, e);
				element.replace(``, { html: true });
			}
		}
	}
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const githubUserName = "your-github-username";

		let cleanPath = url.pathname;
		const pathSegments = cleanPath.split('/');
		const lastSegment = pathSegments[pathSegments.length - 1];

		// Evaluate extension and directory rules
		if ('/.well-known/webfinger' === cleanPath) {
			const resourceParam = url.searchParams.get('resource');
			if (!resourceParam) {
				return new Response('Missing "resource" query parameter', { status: 400 });
			}
			const encodedResource = toBase64Url(resourceParam);
			cleanPath = `/.well-known/webfinger/${encodedResource}.jrd`;
		} else if (cleanPath.startsWith('/-/') && !cleanPath.endsWith('/') && !lastSegment.includes('.')) {
			cleanPath += '.jsonld';
		} else if (!cleanPath.endsWith('/') && !lastSegment.includes('.')) {
			cleanPath += '.html';
		} else if (cleanPath.endsWith('/')) {
			cleanPath += 'default.html';
		}

		const fileName = cleanPath.split('/').pop();
		const fileExtension = fileName.includes('.') ? `.${fileName.split('.').pop()}` : '';

		// Determine the target URL on GitHub Pages using the rewritten path
		let targetUrl = `https://${githubUserName}.github.io${cleanPath}`;

		// Fetch the asset from GitHub with CDN cache overrides
		const proxyHeaders = new Headers();
		for (const key of ['Accept', 'Accept-Encoding', 'Accept-Language', 'If-None-Match', 'If-Modified-Since']) {
			const value = request.headers.get(key);
			if (value) proxyHeaders.set(key, value);
		}

		let response = await fetch(targetUrl, {
			method: 'GET',
			headers: proxyHeaders,
			cf: {
				cacheEverything: true,
				cacheTtl: 3600
			}
		});

		// Dynamic content type adjustments
		let contentType = '';
		if (response.ok) {
			switch (fileExtension) {
				case ".jrd":
					contentType = 'application/jrd+json';
					break;
				case ".jsonld":
					if (cleanPath.startsWith('/-/')) {
						contentType = 'application/activity+json';
					}
					break;
			}
		}

		// Process HTML files for Edge Side Includes (single-depth only — nested includes are not resolved)
		if (response.ok && '.html' === fileExtension) {
			// Initialize HTMLRewriter and pass the current targetUrl as the base for relative links
			const rewriter = new HTMLRewriter().on('include', new IncludeHandler(ctx, targetUrl));

			// Transform the response stream on the fly
			let transformedResponse = rewriter.transform(response);

			// Apply custom headers if needed, otherwise return transformed stream
			if ('' !== contentType) {
				const newHeaders = new Headers(transformedResponse.headers);
				newHeaders.set("Content-Type", contentType);
				return new Response(transformedResponse.body, {
					status: transformedResponse.status,
					statusText: transformedResponse.statusText,
					headers: newHeaders
				});
			}

			return transformedResponse;
		}

		// Handle non-HTML responses with headers modifications
		if ('' !== contentType) {
			const newHeaders = new Headers(response.headers);
			newHeaders.set("Content-Type", contentType);
			newHeaders.set("Cache-Control", "public, max-age=3600");

			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: newHeaders
			});
		}

		return new Response(response.body, response);
	}
};
