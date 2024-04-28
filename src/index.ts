import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { Octokit } from 'octokit';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault('Asia/Tokyo');

export default {
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		if ((await env.kv.get('next-fetch')) === null) {
			await env.kv.put('next-fetch', '0', { type: 'text' });
		}
		if ((await env.kv.get('last-fetched')) === null) {
			await env.kv.put('last-fetched', '0', { type: 'text' });
		}

		const now = dayjs();
		const nextFetchTimeUnix = await env.kv.get('next-fetch');
		const nextFetchTime = dayjs.unix(parseInt(nextFetchTimeUnix));
		if (now.isBefore(nextFetchTime)) {
			console.log("Skipped fetching because it's not time yet.");
			return;
		}

		const lastFetchedTimeUnix = await env.kv.get('last-fetched');
		const lastFetchedTime = dayjs.unix(parseInt(lastFetchedTimeUnix));

		const octokit = new Octokit({ auth: env.GH_TOKEN });

		const res = await octokit.request('GET /notifications', {
			since: lastFetchedTime.toISOString(),
			before: now.toISOString(),
			headers: {
				'X-GitHub-Api-Version': '2022-11-28',
				accept: 'application/vnd.github+json',
			},
		});

		const notifications = res.data;
		const pollInterval = res.headers['X-Poll-Interval'] ?? 60;

		// TODO: Send Webhook
		console.log('notifications', notifications);
		console.log('pollInterval', pollInterval);

		await env.kv.put('last-fetched', now.unix().toString(), { type: 'text' });
		await env.kv.put('next-fetch', now.add(parseInt(pollInterval.toString()), 'seconds').unix().toString(), { type: 'text' });
	},
};
