const { runPipeline } = require('./core/pipeline');

runPipeline()
  .then((result) => {
    if (result) console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error('BOT_FATAL', error.message);
    process.exit(1);
  });