import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { Octokit } from 'octokit';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault('Asia/Tokyo');

export default {
	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
		if ((await env.kv.get('last-fetched')) === null) {
			await env.kv.put('last-fetched', '0', { type: 'text' });
		}

		const now = dayjs();

		// sleeping 💤
		const start = dayjs.tz().set('hour', 1).set('minute', 0).set('second', 0);
		const end = dayjs.tz().set('hour', 8).set('minute', 0).set('second', 0);
		if (now.isAfter(start) && now.isBefore(end)) {
			console.log('Sleeping 💤');
			return;
		}

		const lastFetchedTimeUnix = await env.kv.get('last-fetched');
		const lastFetchedTime = dayjs.unix(parseInt(lastFetchedTimeUnix));

		const octokit = new Octokit({ auth: env.GH_TOKEN });

		const res = await octokit
			.request('GET /notifications', {
				since: lastFetchedTime.toISOString(),
				headers: {
					'X-GitHub-Api-Version': '2022-11-28',
					accept: 'application/vnd.github+json',
					'If-Modified-Since': lastFetchedTime.toISOString(),
				},
			})
			.then((res) => res)
			.catch((err) => {
				// 勝手に throw すな！
				console.error(err);
				return {
					data: [],
				};
			});

		const notifications = res.data.sort((a, b) => {
			return dayjs(a.updated_at).isBefore(dayjs(b.updated_at)) ? -1 : 1;
		});

		for (const notification of notifications) {
			let emoji = 'question';
			let link = `<${notification.repository.html_url}|${notification.repository.full_name}>`;
			const debugMsg = [];

			if (notification.subject.type === 'PullRequest') {
				const prNum = parseInt(notification.subject.url.split('/').slice(-1)[0]);
				try {
					const pr = await octokit.request(`GET /repos/{owner}/{repo}/pulls/{pull_number}`, {
						owner: notification.repository.owner.login,
						repo: notification.repository.name,
						pull_number: prNum,
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
				} catch (e) {
					debugMsg.push(`Error: PR ${notification.repository.full_name}#${prNum}; ${e}`);
					console.error(e);
				}
			} else if (notification.subject.type === 'Issue') {
				const issueNum = parseInt(notification.subject.url.split('/').slice(-1)[0]);
				try {
					const issue = await octokit.request(`GET /repos/{owner}/{repo}/issues/{issue_number}`, {
						owner: notification.repository.owner.login,
						repo: notification.repository.name,
						issue_number: issueNum,
					});

					if (issue.data.state === 'open') {
						emoji = 'issue-open';
					} else if (issue.data.state === 'closed') {
						emoji = 'issue-closed';
					}

					link = `<${issue.data.html_url}|${notification.repository.full_name}#${issue.data.number}>`;
				} catch (e) {
					debugMsg.push(`Error: Issue ${notification.repository.full_name}#${issueNum}; ${e.message}`);
					console.error(e);
				}
			} else {
				console.log(notification);
				debugMsg.push(`Error: Unknown: ${JSON.stringify({ ...notification, repository: 'truncated' })}`);
			}

			const updated_at_unix = dayjs(notification.updated_at).unix();
			const updated_at = dayjs(notification.updated_at).tz().format('YYYY-MM-DD HH:mm:ss');

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
							text: `- Updated at <!date^${updated_at_unix}^{date_pretty} {time_secs}|${updated_at}>`,
						},
					},
				],
			};

			if (notification.last_read_at) {
				const last_read_at_unix = dayjs(notification.last_read_at).unix();
				const last_read_at = dayjs(notification.last_read_at).tz().format('YYYY-MM-DD HH:mm:ss');
				body.blocks[2].text.text += `\n- Last Read at <!date^${last_read_at_unix}^{date_pretty} {time_secs}|${last_read_at}>`;
			}

			if (debugMsg.length > 0) {
				body.blocks.push({
					type: 'section',
					text: {
						type: 'mrkdwn',
						text: `Debug: \`\`\`\n${debugMsg.join('\n')}\n\`\`\``,
					},
				});
			}

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
	},
};
