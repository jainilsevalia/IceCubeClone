const { Anthropic } = require('@anthropic-ai/sdk');

function createAnnotation(core, type, message, file = null, line = null) {
  const annotation = { title: 'PR Review Bot', message };
  if (file) {
    annotation.file = file;
    if (line) annotation.line = line;
  }
  
  switch (type) {
    case 'error':
      core.error(message, annotation);
      break;
    case 'warning':
      core.warning(message, annotation);
      break;
    case 'notice':
      core.notice(message, annotation);
      break;
    default:
      console.log(message);
  }
}

async function getReview(anthropic, content, filename, core) {
  try {
    core.info(`Requesting review from Claude for ${filename}...`);
    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022', // Updated to latest model
      max_tokens: 1000,
      messages: [{
        role: 'user',
        // content: `Review this code change and provide 1-2 key suggestions or concerns, focusing only on the most important issues. Be brief and specific:
        content: `You are a seasoned Senior Developer reviewing a code change. Provide insightful, constructive feedback, identifying logical issues, performance concerns, or maintainability improvements. If possible, add a humorous twist to keep it engaging. Be specific and direct. Do not add long comments. Be a real dev who add comments that make sense and would be short. 
        
File: ${filename}
Changes:
${content}`
      }]
    });
    return response?.content?.[0]?.text?.trim() || null;
  } catch (error) {
    core.error(`Failed to generate review for ${filename}: ${error.message}`);
    return null;
  }
}

async function reviewPR({ github, context, core }) {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY, // Ensure API key is set
  });

  const start_time = Date.now();
  
  try {
    core.info('Starting PR review process...');
    
    const { data: files } = await github.rest.pulls.listFiles({
      ...context.repo,
      pull_number: context.payload.pull_request.number
    });
    core.info(`Found ${files.length} files in the PR`);
    
    const { data: pullRequest } = await github.rest.pulls.get({
      ...context.repo,
      pull_number: context.payload.pull_request.number
    });
    core.info(`PR details fetched: ${pullRequest.title}`);

    let processedFiles = 0;
    let skippedFiles = 0;
    let errorFiles = 0;

    for (const file of files) {
      if (
        file.status === 'removed' ||
        file.filename.match(/\.(pdf|docx|prof|png|jpg|jpeg|gif)$/i)
      ) {
        core.info(`Skipping file: ${file.filename} (removed or unsupported type)`);
        skippedFiles++;
        continue;
      }

      try {
        core.info(`Fetching content for file: ${file.filename}`);
        // Use file.patch if available; otherwise, assume "New file"
        const patch = file.patch || 'New file';

        core.info(`Reviewing file: ${file.filename}`);
        const review = await getReview(anthropic, patch, file.filename, core);

        if (review) {
          core.info(`Creating review comment for file: ${file.filename}`);

          if (!file.patch) {
            core.warning(`Skipping file ${file.filename} - no patch available to determine diff position`);
            continue;
          }

          // Compute the "position" as the relative line index in the patch diff
          const patchLines = file.patch.split('\n');
          let position = null;
          for (let i = 0; i < patchLines.length; i++) {
            const line = patchLines[i];
            // Skip diff headers or file info lines
            if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')) {
              continue;
            }
            // Use the first added line as the comment position
            if (line.startsWith('+')) {
              position = i + 1; // GitHub expects 1-indexed positions
              break;
            }
          }

          if (position === null) {
            core.warning(`Skipping file ${file.filename} - no valid added line found in diff for comment position`);
            continue;
          }

          await github.rest.pulls.createReviewComment({
            ...context.repo,
            pull_number: context.payload.pull_request.number,
            body: review,
            commit_id: pullRequest.head.sha,
            path: file.filename,
            position: position,
          });
          processedFiles++;
        }
      } catch (error) {
        if (error.status !== 404) {
          errorFiles++;
          createAnnotation(core, 'error', 
            `Failed to review ${file.filename}: ${error.message}`, 
            file.filename
          );
        } else {
          core.info(`Skipping file: ${file.filename} (not found)`);
          skippedFiles++;
        }
      }
    }

    const duration = ((Date.now() - start_time) / 1000).toFixed(2);
    createAnnotation(core, 'notice', 
      `PR Review completed in ${duration}s: ${processedFiles} processed, ${skippedFiles} skipped, ${errorFiles} errors`
    );
    core.info(`PR Review completed in ${duration}s`);

  } catch (error) {
    createAnnotation(core, 'error', `PR review process failed: ${error.message}`);
    core.error(`PR review process failed: ${error.message}`);
    throw error;
  }
}

module.exports = { reviewPR };
