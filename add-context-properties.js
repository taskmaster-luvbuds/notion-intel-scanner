#!/usr/bin/env node

/**
 * Script to add context-related Rich Text properties to the Notion Trend Monitors database
 *
 * Properties to add:
 * - source_urls (Rich Text) - URLs of sources checked
 * - top_articles (Rich Text) - Top 3 article titles with links
 * - summary (Rich Text) - Brief explanation of what was found
 * - regions_data (Rich Text) - Which regions had matches
 */

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const MONITORS_DATABASE_ID = process.env.MONITORS_DATABASE_ID;

// Validate environment variables
if (!NOTION_TOKEN) {
  console.error('Error: NOTION_TOKEN environment variable is not set');
  process.exit(1);
}

if (!MONITORS_DATABASE_ID) {
  console.error('Error: MONITORS_DATABASE_ID environment variable is not set');
  process.exit(1);
}

// Properties to add (all Rich Text type for storing context data)
const propertiesToAdd = [
  { name: 'source_urls', type: 'rich_text', description: 'URLs of sources checked' },
  { name: 'top_articles', type: 'rich_text', description: 'Top 3 article titles with links' },
  { name: 'summary', type: 'rich_text', description: 'Brief explanation of what was found' },
  { name: 'regions_data', type: 'rich_text', description: 'Which regions had matches' }
];

async function getDatabase() {
  const response = await fetch(`https://api.notion.com/v1/databases/${MONITORS_DATABASE_ID}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to get database: ${JSON.stringify(error)}`);
  }

  return response.json();
}

async function updateDatabaseProperties(properties) {
  const response = await fetch(`https://api.notion.com/v1/databases/${MONITORS_DATABASE_ID}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ properties })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to update database: ${JSON.stringify(error)}`);
  }

  return response.json();
}

async function main() {
  console.log('='.repeat(60));
  console.log('Notion Trend Monitors - Context Properties Updater');
  console.log('='.repeat(60));
  console.log(`Database ID: ${MONITORS_DATABASE_ID}`);
  console.log('');
  console.log('Properties to add:');
  propertiesToAdd.forEach(prop => {
    console.log(`  - ${prop.name} (${prop.type}): ${prop.description}`);
  });
  console.log('');

  try {
    // Step 1: Get current database schema
    console.log('Step 1: Fetching current database schema...');
    const database = await getDatabase();
    const existingProperties = Object.keys(database.properties);
    console.log(`Found ${existingProperties.length} existing properties:`);
    existingProperties.forEach(prop => {
      console.log(`  - ${prop} (${database.properties[prop].type})`);
    });
    console.log('');

    // Step 2: Determine which properties need to be added
    console.log('Step 2: Checking which properties need to be added...');
    const propertiesToCreate = [];
    const alreadyExists = [];

    for (const prop of propertiesToAdd) {
      if (existingProperties.includes(prop.name)) {
        alreadyExists.push(prop.name);
        console.log(`  [SKIP] "${prop.name}" already exists`);
      } else {
        propertiesToCreate.push(prop);
        console.log(`  [ADD] "${prop.name}" will be added`);
      }
    }
    console.log('');

    // Step 3: Add missing properties
    if (propertiesToCreate.length === 0) {
      console.log('Step 3: No properties to add - all properties already exist!');
      console.log('');
      console.log('='.repeat(60));
      console.log('Summary: All 4 context properties already exist in the database.');
      console.log('='.repeat(60));
      return;
    }

    console.log(`Step 3: Adding ${propertiesToCreate.length} new Rich Text properties...`);

    // Build the properties object for the PATCH request
    // Rich Text properties use an empty object as their configuration
    const newProperties = {};
    for (const prop of propertiesToCreate) {
      newProperties[prop.name] = {
        rich_text: {}
      };
    }

    // Make the API call
    const result = await updateDatabaseProperties(newProperties);
    console.log('Successfully updated database!');
    console.log('');

    // Step 4: Verify the update
    console.log('Step 4: Verifying the update...');
    const updatedDatabase = await getDatabase();
    const updatedProperties = Object.keys(updatedDatabase.properties);

    let allAdded = true;
    for (const prop of propertiesToCreate) {
      if (updatedProperties.includes(prop.name)) {
        const propType = updatedDatabase.properties[prop.name].type;
        if (propType === 'rich_text') {
          console.log(`  [OK] "${prop.name}" successfully added as rich_text`);
        } else {
          console.log(`  [WARN] "${prop.name}" added but type is ${propType} instead of rich_text`);
        }
      } else {
        console.log(`  [FAIL] "${prop.name}" was not added`);
        allAdded = false;
      }
    }
    console.log('');

    // Summary
    console.log('='.repeat(60));
    console.log('Summary:');
    console.log(`  - Properties already existed: ${alreadyExists.length}`);
    if (alreadyExists.length > 0) {
      alreadyExists.forEach(p => console.log(`      * ${p}`));
    }
    console.log(`  - Properties added: ${propertiesToCreate.length}`);
    if (propertiesToCreate.length > 0) {
      propertiesToCreate.forEach(p => console.log(`      * ${p.name} (${p.description})`));
    }
    console.log(`  - Status: ${allAdded ? 'SUCCESS' : 'PARTIAL FAILURE'}`);
    console.log('='.repeat(60));

    if (!allAdded) {
      process.exit(1);
    }

  } catch (error) {
    console.error('');
    console.error('ERROR:', error.message);
    process.exit(1);
  }
}

main();
