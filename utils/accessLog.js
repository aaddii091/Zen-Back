// Who opened a student's case, and when.
//
// Referrals and escalations both carry an `accessLog` array with the same shape,
// so the write lives here once rather than being re-implemented per controller
// with subtly different capping.
//
// Implemented as an aggregation-pipeline update ($concatArrays + $slice) rather
// than $push with $slice because $slice in a $push requires $each and silently
// does nothing without it — a trap worth avoiding in an audit trail, where a
// quiet no-op is the worst possible failure.

const ACCESS_LOG_CAP = 100;

const recordAccess = async (Model, docId, user) => {
  if (!Model || !docId || !user?._id) return;

  await Model.updateOne({ _id: docId }, [
    {
      $set: {
        accessLog: {
          $slice: [
            {
              $concatArrays: [
                { $ifNull: ['$accessLog', []] },
                [
                  {
                    viewer: user._id,
                    viewerRole: String(user.role || ''),
                    at: '$$NOW',
                  },
                ],
              ],
            },
            -ACCESS_LOG_CAP,
          ],
        },
      },
    },
  ]);
};

module.exports = { recordAccess, ACCESS_LOG_CAP };
