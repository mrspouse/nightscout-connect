#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createNightscoutHelper } = require('./lib/sources/glooko/context');
const converter = require('./lib/sources/glooko/convert');

/*
*****************************************************************
* Standalone run args
*****************************************************************
*/ 

function parse_args(argv) {
  var args = {
    input: null,
    output: null,
    offset: 0,
    url: null,
    token: null,
  };

  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];

    if (arg === '--input' || arg === '-i') {
      args.input = argv[++i];
    } else if (arg === '--output' || arg === '-o') {
      args.output = argv[++i];
    } else if (arg === '--offset') {
      args.offset = Number(argv[++i]);
    } else if (arg === '--url' || arg === '-u') {
      args.url = argv[++i];
    } else if (arg === '--token' || arg === '-t') {
      args.token = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }

  return args;
}

function print_help() {
  console.log([
    'Usage: node glooko-convert-standalone.js --input <batch.json> [--offset <ms>] [--output <out.json>] [--url <url>] [--token <token>]',
    '',
    'Options:',
    '  -i, --input    JSON file containing Glooko batch payload',
    '  -o, --output   Optional path to write transformed treatments JSON',
    '      --offset   Timestamp delta in milliseconds (default: 0)',
    '  -u, --url      Nightscout URL (e.g. https://mynightscout.herokuapp.com)',
    '  -t, --token    Nightscout Access Token',
    '  -h, --help     Show this message',
  ].join('\n'));
}

function read_json_file(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf8'));
}

async function run_cli(argv) {
  var args = parse_args(argv);

  if (args.help) {
    print_help();
    return 0;
  }

  if (Number.isNaN(args.offset)) {
    console.error('Invalid --offset value. Expected a number of milliseconds.');
    return 1;
  }

  if (!args.input) {
    console.error('Missing required argument: --input');
    print_help();
    return 1;
  }

  var batch = read_json_file(args.input);

  // Setup Nightscout parameters with environment/CLI fallbacks
  var nsUrl = args.url || process.env.NIGHTSCOUT_URL || 'https://ns-drop-gd.fly.dev';
  var nsToken = args.token || process.env.NIGHTSCOUT_TOKEN || 'aaps-f286719b8dcde96f';

  if (!nsUrl) {
    console.error('Warning: No NIGHTSCOUT_URL provided. Existing record preservation will be skipped.');
  }

  // Build Nightscout context for the transformer
  var ns = createNightscoutHelper({
    url: nsUrl,
    token: nsToken,
  });

  // Access functions from the converter module
  var inputBatch = converter.assign_objects(batch);
  var hasReservoirChanges = inputBatch.reservoirChange && inputBatch.reservoirChange.length > 0;
  var hasPumpAlarms = inputBatch.pumpAlarms && inputBatch.pumpAlarms.length > 0;
  var hasDailyTotals = inputBatch.dailyInsulinTotals && inputBatch.dailyInsulinTotals.length > 0;
  var nsContext = await ns.buildContext({ hasReservoirChanges, hasPumpAlarms, hasDailyTotals });

  var treatments = await converter.generate_nightscout_treatments(batch, args.offset, nsContext);
  var output = JSON.stringify(treatments, null, 2);

  if (args.output) {
    var outputPath = path.resolve(process.cwd(), args.output);
    fs.writeFileSync(outputPath, output + '\n', 'utf8');
    console.log('Wrote treatments to', outputPath);
    return 0;
  }

  process.stdout.write(output + '\n');
  return 0;
}

if (require.main === module) {
  run_cli(process.argv.slice(2))
    .then(function (code) {
      process.exitCode = code;
    })
    .catch(function (error) {
      console.error(error);
      process.exitCode = 1;
    });
}
