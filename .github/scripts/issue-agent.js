const { Anthropic } = require('@anthropic-ai/sdk');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Setup clients
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION,
});

async function extractBranchInfo(issueBody) {
  // AI-assisted extraction of branch information from issue description
  try {
    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Extract the branch name where the issue was found from this GitHub issue description. 
        Return ONLY a JSON object with the format {"branch": "branch-name"} or {"branch": null} if not found.
        
        Issue description:
        ${issueBody}`
      }]
    });

    const extractedText = response?.content?.[0]?.text?.trim() || '{"branch": null}';
    try {
      const result = JSON.parse(extractedText);
      return result.branch;
    } catch (e) {
      console.error('Failed to parse branch info response:', e);
      return null;
    }
  } catch (error) {
    console.error('Error extracting branch info:', error);
    return null;
  }
}

async function analyzeIssueWithKnowledgeBase(issue, knowledgeBaseId) {
  try {
    // Prepare prompt for Bedrock with knowledge base
    const prompt = {
      messageType: "question",
      text: `I need to fix a bug in our codebase. Here's the GitHub issue:
      
      Issue #${issue.number}: ${issue.title}
      
      Description:
      ${issue.body}
      
      Please analyze this issue and:
      1. Identify which files are likely involved
      2. Explain what's causing the issue
      3. Provide a specific fix
      
      Return your response as a JSON object with this format:
      {
        "analysis": "Your analysis of the issue",
        "files": ["list", "of", "affected", "files"],
        "solution": "Description of the solution",
        "changes": [
          {
            "file": "path/to/file",
            "original": "snippet of code to be replaced",
            "replacement": "replacement code"
          }
        ],
        "commitMessage": "Suggested commit message"
      }`
    };

    // Query AWS Bedrock with knowledge base context
    const bedrockParams = {
      modelId: 'anthropic.claude-3-5-sonnet-v1',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4000,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt.text }] }],
        knowledgeBaseId: knowledgeBaseId
      })
    };

    const command = new InvokeModelCommand(bedrockParams);
    const response = await bedrock.send(command);
    
    // Parse response
    const responseBody = JSON.parse(Buffer.from(response.body).toString('utf8'));
    const responseText = responseBody.content[0].text;
    
    // Extract JSON from the response
    const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/) || 
                      responseText.match(/{[\s\S]*}/) ||
                      responseText;
                      
    const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : responseText;
    
    try {
      return JSON.parse(jsonStr.replace(/```json|```/g, '').trim());
    } catch (e) {
      console.error('Failed to parse JSON from response:', e);
      throw new Error('Failed to parse solution from AI response');
    }
  } catch (error) {
    console.error('Error analyzing issue with knowledge base:', error);
    throw error;
  }
}

async function applyChanges(solution) {
  for (const change of solution.changes) {
    if (!change.file || !change.replacement) {
      console.log(`Skipping invalid change for file: ${change.file}`);
      continue;
    }

    const filePath = change.file;
    
    try {
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        console.log(`File does not exist: ${filePath}`);
        continue;
      }
      
      // Read file
      let content = fs.readFileSync(filePath, 'utf8');
      
      // Apply change (simple replacement, could be more sophisticated)
      if (change.original) {
        content = content.replace(change.original, change.replacement);
      } else {
        // If no specific original code is provided, just replace the whole file
        content = change.replacement;
      }
      
      // Write back to file
      fs.writeFileSync(filePath, content);
      console.log(`Updated file: ${filePath}`);
    } catch (error) {
      console.error(`Error updating file ${filePath}:`, error);
      throw error;
    }
  }
}

async function processIssue({ github, context, core }) {
  try {
    const issue = context.payload.issue;
    
    core.info(`Processing issue #${issue.number}: ${issue.title}`);
    
    // 1. Extract branch information from issue description
    let baseBranch = await extractBranchInfo(issue.body);
    // Default to main or master if branch not specified
    baseBranch = baseBranch || 'main'; 
    
    // 2. Create a new branch for the fix
    const newBranch = `issue-${issue.number}`;
    
    core.info(`Using base branch: ${baseBranch}`);
    core.info(`Creating new branch: ${newBranch}`);
    
    try {
      execSync(`git fetch origin ${baseBranch} --depth=1`);
      execSync(`git checkout -b ${newBranch} origin/${baseBranch}`);
    } catch (error) {
      core.warning(`Error checking out branch: ${error.message}`);
      // Try from local main as fallback
      execSync(`git checkout -b ${newBranch}`);
    }
    
    // 3. Analyze the issue using AI with knowledge base context
    core.info('Analyzing issue with AI and knowledge base...');
    const solution = await analyzeIssueWithKnowledgeBase(issue, process.env.KNOWLEDGE_BASE_ID);
    
    core.info(`AI solution found. Affected files: ${solution.files.join(', ')}`);
    
    // 4. Apply the suggested changes
    core.info('Applying changes to files...');
    await applyChanges(solution);
    
    // 5. Commit and push changes
    core.info('Committing changes...');
    execSync('git add .');
    execSync(`git commit -m "${solution.commitMessage || `Fix issue #${issue.number}`}"`);
    
    core.info('Pushing to remote...');
    execSync(`git push -u origin ${newBranch}`);
    
    // 6. Create a pull request
    core.info('Creating pull request...');
    const pr = await github.rest.pulls.create({
      ...context.repo,
      title: `Fix issue #${issue.number}: ${issue.title}`,
      body: `This PR addresses issue #${issue.number}\n\n${solution.analysis}\n\n${solution.solution}\n\nAutomatically generated by Code Agent.`,
      head: newBranch,
      base: baseBranch
    });
    
    // 7. Add comment to the issue with a link to the PR
    await github.rest.issues.createComment({
      ...context.repo,
      issue_number: issue.number,
      body: `I've created a fix for this issue in PR #${pr.data.number} (${pr.data.html_url}). Please review the changes.`
    });
    
    core.info(`Successfully created PR #${pr.data.number}`);
    
  } catch (error) {
    core.error(`Error processing issue: ${error.message}`);
    throw error;
  }
}

module.exports = { processIssue }; 