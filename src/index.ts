import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { Octokit } from 'octokit';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault('Asia/Tokyo');

export default {
	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
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

		const notifications = res.data.sort((a, b) => {
			return dayjs(a.updated_at).isBefore(dayjs(b.updated_at)) ? -1 : 1;
		});
		const pollInterval = res.headers['X-Poll-Interval'] ?? 60;

		for (const notification of notifications) {
			console.log('notification', notification);

			let emoji = 'question';
			let link = `<${notification.repository.html_url}|${notification.repository.full_name}>`;

			if (notification.subject.type === 'PullRequest') {
				const pr = await octokit.request(`GET /repos/{owner}/{repo}/pulls/{pull_number}`, {
					owner: notification.repository.owner.login,
					repo: notification.repository.name,
					pull_number: parseInt(notification.subject.url.split('/').slice(-1)[0]),
				});

				if (pr.data.draft) {
					emoji = 'draft-pr';
				} else if (pr.data.merged) {
					emoji = 'merged';
				} else if (pr.data.state === 'open') {
					emoji = 'pr-open';
				} else if (pr.data.state === 'closed') {
					emoji = 'pr-closed';
				}

				link = `<${pr.data.html_url}|${notification.repository.full_name}#${pr.data.number}>`;
			} else if (notification.subject.type === 'Issue') {
				const issue = await octokit.request(`GET /repos/{owner}/{repo}/issues/{issue_number}`, {
					owner: notification.repository.owner.login,
					repo: notification.repository.name,
					issue_number: parseInt(notification.subject.url.split('/').slice(-1)[0]),
				});

				if (issue.data.state === 'open') {
					emoji = 'issue-open';
				} else if (issue.data.state === 'closed') {
					emoji = 'issue-closed';
				}

				link = `<${issue.data.html_url}|${notification.repository.full_name}#${issue.data.number}>`;
			}

			const updated_at_unix = dayjs(notification.updated_at).unix();
			const updated_at = dayjs(notification.updated_at).tz().format('YYYY-MM-DD HH:mm:ss');
			const last_read_at_unix = dayjs(notification.last_read_at).unix();
			const last_read_at = dayjs(notification.last_read_at).tz().format('YYYY-MM-DD HH:mm:ss');

			// https://api.slack.com/reference/surfaces/formatting
			// https://api.slack.com/messaging/webhooks
			const body = {
				blocks: [
					{
						type: 'header',
						text: {
							type: 'plain_text',
							text: `:${emoji}: ${notification.subject.title}`,
							emoji: true,
						},
					},
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `${link} (${notification.reason})`,
						},
					},
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `- Updated at <!date^${updated_at_unix}^{date_pretty} {time}|${updated_at}>\n- Last Read at <!date^${last_read_at_unix}^{date_pretty} {time}|${last_read_at}>`,
						},
					},
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `Debug: \`\`\`\n${JSON.stringify({ ...notification, repository: 'truncated' }, null, 2)}\n\`\`\``,
						},
					},
				],
			};

			await fetch(env.WH_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			});

			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		await env.kv.put('last-fetched', now.unix().toString(), { type: 'text' });
		await env.kv.put('next-fetch', now.add(parseInt(pollInterval.toString()), 'seconds').unix().toString(), { type: 'text' });
	},
};
