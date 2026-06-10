function toBase64Url(str) {
	const base64 = btoa(str);
	return base64
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, ''); // Remove padding character
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const githubUserName = "your-github-username";

		let cleanPath = url.pathname;
		const pathSegments = cleanPath.split('/');
		const lastSegment = pathSegments[pathSegments.length - 1];

		// Evaluate extension and directory rules
		if ('/.well-known/webfinger' === cleanPath) {
			const resourceParam = url.searchParams.get('resource');
			if (resourceParam) {
				const encodedResource = toBase64Url(resourceParam);
				cleanPath = `/.well-known/webfinger/${encodedResource}.jrd`;
			}
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
		let response = await fetch(targetUrl, {
			method: request.method,
			headers: request.headers,
			cf: {
				cacheEverything: true,
				cacheTtl: 3600
			}
		});

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

		if ('' != contentType) {
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
