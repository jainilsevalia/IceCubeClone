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
    console.log('Sending to Claude:', {
      filename,
      content: content.substring(0, 500) + '...' // Log first 500 chars of content
    });

    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `As a Senior Developer, review the following code changes and provide specific feedback.

IMPORTANT - You must format your response EXACTLY as a JSON array like this example:
[
  {
    "line": 12,
    "comment": "Consider using const instead of let here since the value isn't reassigned"
  },
  {
    "line": 45,
    "comment": "This loop could be simplified using Array.map()"
  }
]

Rules:
1. Each comment must reference a specific line number from the diff
2. Comments must be short and specific to that line
3. The line number must be the actual line number from the new file
4. Response must be valid JSON that can be parsed
5. Do not include any text outside the JSON array

Here are the changes to review:
File: ${filename}
Diff:
${content}`
      }]
    });

    console.log('Raw Claude Response:', JSON.stringify(response, null, 2));
    const reviewText = response?.content?.[0]?.text?.trim() || null;
    console.log('Extracted Review Text:', reviewText);
    
    // Validate JSON response
    let reviews;
    try {
      reviews = JSON.parse(reviewText);
      console.log('Parsed Reviews:', JSON.stringify(reviews, null, 2));

      if (!Array.isArray(reviews)) {
        throw new Error('Response is not an array');
      }
      
      // Validate each review object
      reviews = reviews.filter(review => {
        const isValid = (
          typeof review === 'object' &&
          typeof review.line === 'number' &&
          typeof review.comment === 'string' &&
          review.line > 0 &&
          review.comment.length > 0
        );
        if (!isValid) {
          console.log('Filtered out invalid review:', review);
        }
        return isValid;
      });
      
      console.log('Final Validated Reviews:', JSON.stringify(reviews, null, 2));
      return reviews;
    } catch (error) {
      core.warning(`Invalid review format received: ${error.message}`);
      console.log('JSON Parse Error:', error);
      console.log('Invalid Review Text:', reviewText);
      return null;
    }
  } catch (error) {
    core.error(`Failed to generate review for ${filename}: ${error.message}`);
    console.log('API Error:', error);
    return null;
  }
}

async function reviewPR({ github, context, core }) {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const start_time = Date.now();
  
  try {
    core.info('Starting PR review process...');
    
    const { data: files } = await github.rest.pulls.listFiles({
      ...context.repo,
      pull_number: context.payload.pull_request.number
    });
    console.log('Files in PR:', files.map(f => ({ 
      filename: f.filename, 
      status: f.status,
      additions: f.additions,
      deletions: f.deletions
    })));
    
    const { data: pullRequest } = await github.rest.pulls.get({
      ...context.repo,
      pull_number: context.payload.pull_request.number
    });
    console.log('PR Details:', {
      title: pullRequest.title,
      number: pullRequest.number,
      state: pullRequest.state,
      head_sha: pullRequest.head.sha
    });

    let processedFiles = 0;
    let skippedFiles = 0;
    let errorFiles = 0;

    for (const file of files) {
      console.log('\nProcessing file:', file.filename);
      
      if (
        file.status === 'removed' ||
        file.filename.match(/\.(pdf|docx|prof|png|jpg|jpeg|gif)$/i)
      ) {
        core.info(`Skipping file: ${file.filename} (removed or unsupported type)`);
        skippedFiles++;
        continue;
      }

      try {
        console.log('File patch:', file.patch?.substring(0, 500) + '...');

        const reviews = await getReview(anthropic, file.patch || 'New file', file.filename, core);
        console.log('Reviews received:', reviews);

        if (reviews && Array.isArray(reviews)) {
          for (const review of reviews) {
            if (!file.patch) {
              core.warning(`Skipping file ${file.filename} - no patch available`);
              continue;
            }

            const patchLines = file.patch.split('\n');
            console.log('Processing review:', review);
            console.log('Patch line count:', patchLines.length);

            let lineCounter = 0;
            let position = null;

            // Find the actual position in the diff
            for (let i = 0; i < patchLines.length; i++) {
              const line = patchLines[i];
              if (line.startsWith('@@')) {
                const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
                if (match) {
                  lineCounter = parseInt(match[1]) - 1;
                  console.log('New hunk starting at line:', lineCounter);
                  continue;
                }
              }
              
              if (!line.startsWith('---') && !line.startsWith('+++')) {
                if (!line.startsWith('-')) {
                  lineCounter++;
                }
                
                if (lineCounter === review.line) {
                  position = i + 1;
                  console.log('Found position', position, 'for line', review.line);
                  console.log('Line content:', line);
                  break;
                }
              }
            }

            if (position) {
              console.log('Creating review comment:', {
                path: file.filename,
                position: position,
                line: review.line,
                comment: review.comment
              });

              await github.rest.pulls.createReviewComment({
                ...context.repo,
                pull_number: context.payload.pull_request.number,
                body: review.comment,
                commit_id: pullRequest.head.sha,
                path: file.filename,
                position: position,
              });
              processedFiles++;
            } else {
              console.log('Failed to find position for line:', review.line);
              core.warning(`Could not find position for line ${review.line} in ${file.filename}`);
            }
          }
        }
      } catch (error) {
        console.log('Error processing file:', error);
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
    console.log('Final Statistics:', {
      duration,
      processedFiles,
      skippedFiles,
      errorFiles
    });

    createAnnotation(core, 'notice', 
      `PR Review completed in ${duration}s: ${processedFiles} processed, ${skippedFiles} skipped, ${errorFiles} errors`
    );
    core.info(`PR Review completed in ${duration}s`);

  } catch (error) {
    console.log('Fatal error:', error);
    createAnnotation(core, 'error', `PR review process failed: ${error.message}`);
    core.error(`PR review process failed: ${error.message}`);
    throw error;
  }
}

module.exports = { reviewPR };
